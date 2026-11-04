import {
  ApiError,
  type Domain,
  type domainCreateSchema,
  type domainPatchSchema,
  type Pagination,
} from "@linq/shared"
import { sql, type Selectable } from "kysely"
import type { z } from "zod"
import type { Principal } from "../auth/middleware.ts"
import { assertCan, assertCanPurge } from "../auth/permissions.ts"
import { domainKey } from "../infra/cache.ts"
import { isAppHost } from "../infra/config.ts"
import type { Db } from "../infra/db/client.ts"
import type { DB } from "../infra/db/types.generated.ts"
import type { Deps } from "../deps.ts"
import { span } from "../infra/log.ts"

type DomainCreate = z.infer<typeof domainCreateSchema>
type DomainPatch = z.infer<typeof domainPatchSchema>

type DomainRow = Selectable<DB["domains"]> & { link_count: number }

/** Maps a domain row and its link count to the JSON shape the API returns. */
function toDomain({ link_count, ...domain }: DomainRow): Domain {
  return {
    id: domain.id,
    host: domain.host,
    fallback_url: domain.fallback_url,
    base_path_redirect: domain.base_path_redirect,
    invalid_short_url_redirect: domain.invalid_short_url_redirect,
    status: domain.status,
    link_count,
    created_at: domain.created_at.toISOString(),
    updated_at: domain.updated_at.toISOString(),
  }
}

/**
 * Links per domain, archived included: the number that must reach zero before
 * the domain may be archived or purged. See `assertNoLinks`.
 */
function domainQuery(db: Db) {
  const counts = db
    .selectFrom("links")
    .select(["domain_id", sql<number>`count(*)`.as("n")])
    .groupBy("domain_id")
    .as("link_counts")

  return db
    .selectFrom("domains")
    .leftJoin(counts, "link_counts.domain_id", "domains.id")
    .selectAll("domains")
    .select(sql<number>`coalesce(link_counts.n, 0)`.as("link_count"))
}

/** Loads one domain as a complete API response, or throws 404. */
function fetchDomain(db: Db, id: string): Promise<Domain> {
  return span(
    "domain.fetch",
    async () => {
      const row = await domainQuery(db).where("domains.id", "=", id).limit(1).executeTakeFirst()
      if (!row) throw ApiError.notFound("domain")
      return toDomain(row)
    },
    { in: { domain_id: id }, out: (domain) => ({ host: domain.host, status: domain.status }) },
  )
}

/**
 * A domain may be retired only when nothing points at it — archived links
 * included. Archiving stops the host serving and purging takes its visits
 * with it, and an archived link still owns its slug on that host
 * (resources/docs/adr/0002), so either operation would strand a row that has nowhere
 * to go. Purging the links is the only way through, by design.
 */
function assertNoLinks(db: Db, domain_id: string): Promise<void> {
  return span(
    "domain.assertNoLinks",
    async () => {
      const { n = 0 } =
        (await db
          .selectFrom("links")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .where("domain_id", "=", domain_id)
          .executeTakeFirst()) ?? {}
      if (n > 0) {
        throw ApiError.conflict(`domain still has ${n} link${n === 1 ? "" : "s"}; purge them first`)
      }
    },
    { in: { domain_id } },
  )
}

/**
 * True for Postgres SQLSTATE 23503 (foreign_key_violation), read off `code`
 * rather than an `instanceof` check so it works the same whether the error
 * came from Bun's `SQL.PostgresError` (production) or PGlite's driver (tests).
 */
function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23503"
}

export async function listDomains({ db }: Deps, { limit, offset }: Pagination) {
  const rows = await domainQuery(db).orderBy("domains.host").limit(limit).offset(offset).execute()
  const { total = 0 } =
    (await db.selectFrom("domains").select((eb) => eb.fn.countAll<number>().as("total")).executeTakeFirst()) ?? {}
  return { data: rows.map(toDomain), total, limit, offset }
}

export function getDomain({ db }: Deps, id: string): Promise<Domain> {
  return fetchDomain(db, id)
}

export async function createDomain(
  { db, config, cache, caddy }: Deps,
  principal: Principal,
  body: DomainCreate,
): Promise<Domain> {
  assertCan(principal, "create", "Domain")
  // The Client UI claims every path on the app host, so no link there could resolve.
  if (isAppHost(config, body.host)) {
    throw ApiError.validation(`${body.host} is LINQ_APP_HOST and cannot be a domain`)
  }

  const row = await db
    .insertInto("domains")
    .values({
      id: Bun.randomUUIDv7(),
      host: body.host,
      fallback_url: body.fallback_url ?? null,
      base_path_redirect: body.base_path_redirect ?? null,
      invalid_short_url_redirect: body.invalid_short_url_redirect ?? null,
    })
    .onConflict((oc) => oc.column("host").doNothing())
    .returningAll()
    .executeTakeFirst()
  if (!row) throw ApiError.conflict(`domain ${body.host} already exists`)

  // Clears the negative entry a request to this host left behind while it 404'd.
  await cache.del(domainKey(row.host))
  await caddy.upsert(row.id, row.host)
  return toDomain({ ...row, link_count: 0 })
}

export async function updateDomain(
  { db, cache, caddy }: Deps,
  principal: Principal,
  id: string,
  patch: DomainPatch,
): Promise<Domain> {
  assertCan(principal, "update", "Domain")
  const before = await fetchDomain(db, id)

  if (patch.status === "archived") {
    // The check and the update are one transaction under a row lock, not
    // because the transaction itself would close the race under READ
    // COMMITTED (it would not), but because FOR UPDATE conflicts with
    // createLink's FOR SHARE on the same domain row. That is what
    // serialises the two requests; do not simplify this to a plain
    // transaction.
    await db.transaction().execute(async (tx) => {
      await tx.selectFrom("domains").select("id").where("id", "=", id).forUpdate().execute()
      await assertNoLinks(tx, id)
      await tx
        .updateTable("domains")
        .set({ ...patch, updated_at: new Date() })
        .where("id", "=", id)
        .execute()
    })
  } else {
    await db
      .updateTable("domains")
      .set({ ...patch, updated_at: new Date() })
      .where("id", "=", id)
      .execute()
  }
  // Every patchable field except the status itself — the three redirect
  // URLs — is what the redirect handler reads out of the cached entry.
  await cache.del(domainKey(before.host))
  // A redirect-only patch changes nothing Caddy needs to know about.
  if (patch.status !== undefined) {
    if (patch.status === "archived") await caddy.remove(id)
    else await caddy.upsert(id, before.host)
  }
  return fetchDomain(db, id)
}

/** An alias for archiving; domains are never dropped. See resources/docs/adr/0002. */
export async function archiveDomain(
  { db, cache, caddy }: Deps,
  principal: Principal,
  id: string,
): Promise<Domain> {
  assertCan(principal, "archive", "Domain")
  const before = await fetchDomain(db, id)

  // See the identical lock in updateDomain above — same race, same fix.
  await db.transaction().execute(async (tx) => {
    await tx.selectFrom("domains").select("id").where("id", "=", id).forUpdate().execute()
    await assertNoLinks(tx, id)
    await tx
      .updateTable("domains")
      .set({ status: "archived", updated_at: new Date() })
      .where("id", "=", id)
      .execute()
  })
  await cache.del(domainKey(before.host))
  await caddy.remove(id)
  return fetchDomain(db, id)
}

/**
 * Destroys an archived, empty domain for good, and its visits with it. Admin
 * only, and archived-first. See resources/docs/adr/0002.
 */
export async function purgeDomain({ db, cache, caddy }: Deps, principal: Principal, id: string): Promise<void> {
  assertCanPurge(principal)
  const domain = await fetchDomain(db, id)
  if (domain.status !== "archived") {
    throw ApiError.conflict("archive the domain before purging it")
  }

  await db.transaction().execute(async (tx) => {
    await tx.selectFrom("domains").select("id").where("id", "=", id).forUpdate().execute()
    await assertNoLinks(tx, id)
    try {
      await span("domain.purge", async () => tx.deleteFrom("domains").where("id", "=", id).execute(), {
        in: { domain_id: id, host: domain.host },
      })
    } catch (err) {
      // The pre-check above is for the message; `links.domain_id` is ON
      // DELETE RESTRICT, so Postgres is what actually guarantees this. A
      // link created between the two would otherwise surface as an
      // unhandled FK violation, which app.ts reports as a 500 — a worse
      // answer than the 409 the same request would have got a moment
      // earlier. Mapped here, not in app.onError, so a genuine referential
      // bug elsewhere in the app is never hidden behind this message.
      if (isForeignKeyViolation(err)) {
        throw ApiError.conflict("domain still has links; purge them first")
      }
      throw err
    }
  })
  await cache.del(domainKey(domain.host))
  // Defensive, not load-bearing: purging requires the domain already
  // archived, so its route is normally gone already. Idempotent either way.
  await caddy.remove(id)
}
