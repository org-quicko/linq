import {
  ApiError,
  type Domain,
  type domainCreateSchema,
  type domainPatchSchema,
} from "@linq/shared"
import { type Selectable, sql } from "kysely"
import type { z } from "zod"
import type { DB } from "../db/types.generated.ts"
import { type Caddy, type Db, span } from "../libs/index.ts"

type DomainCreateInput = z.infer<typeof domainCreateSchema>
type DomainPatch = z.infer<typeof domainPatchSchema>

/** Maps a domain row and its link count to the JSON shape the API returns. */
function toDomain({
  link_count: linkCount,
  ...domain
}: Selectable<DB["domains"]> & { link_count: number }): Domain {
  return {
    id: domain.id,
    host: domain.host,
    fallback_url: domain.fallback_url,
    base_path_redirect: domain.base_path_redirect,
    invalid_short_url_redirect: domain.invalid_short_url_redirect,
    status: domain.status,
    link_count: linkCount,
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

/**
 * A domain may be retired only when nothing points at it — archived links
 * included. Archiving stops the host serving and purging takes its visits
 * with it, and an archived link still owns its slug on that host
 * (resources/docs/adr/0002), so either operation would strand a row that has nowhere
 * to go. Purging the links is the only way through, by design.
 *
 * Called under a FOR UPDATE row lock on the domain, which conflicts with
 * `createLink`'s FOR SHARE on the same row: that lock, not the transaction
 * alone (READ COMMITTED would not close the race), is what serialises an
 * archive against a concurrent link create. Do not simplify it away.
 */
async function assertNoLinks(tx: Db, domainId: string): Promise<void> {
  await span(
    "domain.assertNoLinks",
    async () => {
      await tx.selectFrom("domains").select("id").where("id", "=", domainId).forUpdate().execute()
      const { n = 0 } =
        (await tx
          .selectFrom("links")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .where("domain_id", "=", domainId)
          .executeTakeFirst()) ?? {}
      if (n > 0) {
        throw ApiError.conflict(`domain still has ${n} link${n === 1 ? "" : "s"}; purge them first`)
      }
    },
    { in: { domain_id: domainId } },
  )
}

/** Loads one domain as a complete API response, or throws 404. */
export function getDomain(db: Db, id: string): Promise<Domain> {
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

export async function listDomains(db: Db, { limit, offset }: { limit: number; offset: number }) {
  const rows = await domainQuery(db).orderBy("domains.host").limit(limit).offset(offset).execute()
  const { total = 0 } =
    (await db
      .selectFrom("domains")
      .select((eb) => eb.fn.countAll<number>().as("total"))
      .executeTakeFirst()) ?? {}
  return { data: rows.map(toDomain), total }
}

/** 409 when the host is already registered, archived or not. */
export async function createDomain(db: Db, input: DomainCreateInput): Promise<Domain> {
  const row = await db
    .insertInto("domains")
    .values({
      id: Bun.randomUUIDv7(),
      host: input.host,
      fallback_url: input.fallback_url ?? null,
      base_path_redirect: input.base_path_redirect ?? null,
      invalid_short_url_redirect: input.invalid_short_url_redirect ?? null,
    })
    .onConflict((oc) => oc.column("host").doNothing())
    .returningAll()
    .executeTakeFirst()
  if (!row) throw ApiError.conflict(`domain ${input.host} already exists`)
  return toDomain({ ...row, link_count: 0 })
}

/** Archiving through a patch takes the same lock and link check as `archiveDomain`. */
export async function updateDomain(db: Db, id: string, patch: DomainPatch): Promise<void> {
  await db.transaction().execute(async (tx) => {
    if (patch.status === "archived") await assertNoLinks(tx, id)
    await tx
      .updateTable("domains")
      .set({ ...patch, updated_at: new Date() })
      .where("id", "=", id)
      .execute()
  })
}

/** Archiving keeps the row; domains are never dropped by DELETE. See resources/docs/adr/0002. */
export async function archiveDomain(db: Db, id: string): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await assertNoLinks(tx, id)
    await tx
      .updateTable("domains")
      .set({ status: "archived", updated_at: new Date() })
      .where("id", "=", id)
      .execute()
  })
}

/** Destroys an archived, empty domain for good, and its visits with it. See resources/docs/adr/0002. */
export async function purgeDomain(db: Db, domain: Domain): Promise<void> {
  if (domain.status !== "archived") throw ApiError.conflict("archive the domain before purging it")

  await db.transaction().execute(async (tx) => {
    await assertNoLinks(tx, domain.id)
    try {
      await span(
        "domain.purge",
        async () => tx.deleteFrom("domains").where("id", "=", domain.id).execute(),
        {
          in: { domain_id: domain.id, host: domain.host },
        },
      )
    } catch (err) {
      // The pre-check above is for the message; `links.domain_id` is ON
      // DELETE RESTRICT, so Postgres is what actually guarantees this. A
      // link created between the two would otherwise surface as an
      // unhandled FK violation, which app.ts reports as a 500 — a worse
      // answer than the 409 the same request would have got a moment
      // earlier. Mapped here, not in app.onError, so a genuine referential
      // bug elsewhere in the app is never hidden behind this message.
      // SQLSTATE 23503 is read off `code`, not an `instanceof`, so it works the
      // same for node-postgres (production) and PGlite (tests).
      if ((err as { code?: unknown } | null)?.code === "23503") {
        throw ApiError.conflict("domain still has links; purge them first")
      }
      throw err
    }
  })
}

/**
 * Repairs Caddy's routes after Caddy's own restart wipes it back to its empty
 * skeleton. The only place a mutation reads every domain instead of one — a
 * boot-time cost, paid once, never per-request. LINQ_APP_HOST is no domain
 * row, so it gets its own fixed route here; changing it takes a restart.
 */
export async function reconcileCaddy(db: Db, caddy: Caddy, appHost?: string): Promise<void> {
  const rows = await db
    .selectFrom("domains")
    .select(["id", "host"])
    .where("status", "=", "active")
    .execute()
  for (const row of rows) await caddy.upsert(row.id, row.host)
  if (appHost) await caddy.upsert("app-host", appHost)
}
