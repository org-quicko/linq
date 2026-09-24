import {
  ApiError,
  type Domain,
  domainCreateSchema,
  domainPatchSchema,
  paginationSchema,
  uuidSchema,
} from "@linq/shared"
import { sql, type Selectable } from "kysely"
import { Hono } from "hono"
import { z } from "zod"
import { assertCan, assertCanPurge } from "../../auth/permissions.ts"
import { domainKey } from "../../cache.ts"
import { isAppHost } from "../../config.ts"
import type { Db } from "../../db/client.ts"
import type { DB } from "../../db/types.generated.ts"
import { span } from "../../log.ts"
import type { Env } from "../env.ts"
import { validate } from "../validate.ts"

const idParam = validate("param", z.object({ id: uuidSchema }))

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
 * (docs/adr/0002), so either operation would strand a row that has nowhere
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

export const domainRoutes = new Hono<Env>()
  .get("/", validate("query", paginationSchema), async (c) => {
    const { limit, offset } = c.req.valid("query")
    const rows = await domainQuery(c.var.db).orderBy("domains.host").limit(limit).offset(offset).execute()
    const { total = 0 } =
      (await c.var.db.selectFrom("domains").select((eb) => eb.fn.countAll<number>().as("total")).executeTakeFirst()) ?? {}
    return c.json({ data: rows.map(toDomain), total, limit, offset })
  })

  .post("/", validate("json", domainCreateSchema), async (c) => {
    assertCan(c.var.principal, "create", "Domain")
    const body = c.req.valid("json")
    // The Client UI claims every path on the app host, so no link there could resolve.
    if (isAppHost(c.var.config, body.host)) {
      throw ApiError.validation(`${body.host} is LINQ_APP_HOST and cannot be a domain`)
    }

    const row = await c.var.db
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
    await c.var.cache.del(domainKey(row.host))
    await c.var.caddy.upsert(row.id, row.host)
    return c.json(toDomain({ ...row, link_count: 0 }), 201)
  })

  .get("/:id", idParam, async (c) => c.json(await fetchDomain(c.var.db, c.req.valid("param").id)))

  .patch("/:id", idParam, validate("json", domainPatchSchema), async (c) => {
    assertCan(c.var.principal, "update", "Domain")
    const { id } = c.req.valid("param")
    const patch = c.req.valid("json")

    const before = await fetchDomain(c.var.db, id)

    if (patch.status === "archived") {
      // The check and the update are one transaction under a row lock, not
      // because the transaction itself would close the race under READ
      // COMMITTED (it would not), but because FOR UPDATE conflicts with
      // POST /links's FOR SHARE on the same domain row. That is what
      // serialises the two requests; do not simplify this to a plain
      // transaction.
      await c.var.db.transaction().execute(async (tx) => {
        await tx.selectFrom("domains").select("id").where("id", "=", id).forUpdate().execute()
        await assertNoLinks(tx, id)
        await tx
          .updateTable("domains")
          .set({ ...patch, updated_at: new Date() })
          .where("id", "=", id)
          .execute()
      })
    } else {
      await c.var.db
        .updateTable("domains")
        .set({ ...patch, updated_at: new Date() })
        .where("id", "=", id)
        .execute()
    }
    // Every patchable field except the status itself — the three redirect
    // URLs — is what the redirect handler reads out of the cached entry.
    await c.var.cache.del(domainKey(before.host))
    // A redirect-only patch changes nothing Caddy needs to know about.
    if (patch.status !== undefined) {
      if (patch.status === "archived") await c.var.caddy.remove(id)
      else await c.var.caddy.upsert(id, before.host)
    }
    return c.json(await fetchDomain(c.var.db, id))
  })

  /** DELETE is an alias for archiving; domains are never dropped. See docs/adr/0002. */
  .delete("/:id", idParam, async (c) => {
    assertCan(c.var.principal, "archive", "Domain")
    const { id } = c.req.valid("param")

    const before = await fetchDomain(c.var.db, id)

    // See the identical lock in PATCH /:id above — same race, same fix.
    await c.var.db.transaction().execute(async (tx) => {
      await tx.selectFrom("domains").select("id").where("id", "=", id).forUpdate().execute()
      await assertNoLinks(tx, id)
      await tx
        .updateTable("domains")
        .set({ status: "archived", updated_at: new Date() })
        .where("id", "=", id)
        .execute()
    })
    await c.var.cache.del(domainKey(before.host))
    await c.var.caddy.remove(id)
    return c.json(await fetchDomain(c.var.db, id))
  })

  /**
   * Destroys an archived, empty domain for good, and its visits with it. Admin
   * only, and archived-first. See docs/adr/0002.
   */
  .delete("/:id/purge", idParam, async (c) => {
    assertCanPurge(c.var.principal)
    const { id } = c.req.valid("param")

    const domain = await fetchDomain(c.var.db, id)
    if (domain.status !== "archived") {
      throw ApiError.conflict("archive the domain before purging it")
    }

    await c.var.db.transaction().execute(async (tx) => {
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
    await c.var.cache.del(domainKey(domain.host))
    // Defensive, not load-bearing: purging requires the domain already
    // archived, so its route is normally gone already. Idempotent either way.
    await c.var.caddy.remove(id)
    return c.body(null, 204)
  })
