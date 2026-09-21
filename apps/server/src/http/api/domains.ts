import {
  ApiError,
  type Domain,
  domainCreateSchema,
  domainPatchSchema,
  paginationSchema,
  uuidSchema,
} from "@linq/shared"
import { asc, count, eq, sql } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import { assertCanPurge, assertRole } from "../../auth/permissions.ts"
import { domainKey } from "../../cache.ts"
import type { Db } from "../../db/client.ts"
import { domains, links } from "../../db/schema.ts"
import { span } from "../../log.ts"
import type { Env } from "../env.ts"
import { validate } from "../validate.ts"

const idParam = validate("param", z.object({ id: uuidSchema }))

type DomainRow = { domain: typeof domains.$inferSelect; link_count: number }

/** Maps a domain row and its link count to the JSON shape the API returns. */
function toDomain({ domain, link_count }: DomainRow): Domain {
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
    .select({ domain_id: links.domain_id, n: sql<number>`count(*)`.as("n") })
    .from(links)
    .groupBy(links.domain_id)
    .as("link_counts")

  return db
    .select({
      domain: domains,
      link_count: sql<number>`coalesce(${counts.n}, 0)`.mapWith(Number),
    })
    .from(domains)
    .leftJoin(counts, eq(counts.domain_id, domains.id))
}

/** Loads one domain as a complete API response, or throws 404. */
function fetchDomain(db: Db, id: string): Promise<Domain> {
  return span(
    "domain.fetch",
    async () => {
      const [row] = await domainQuery(db).where(eq(domains.id, id)).limit(1)
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
      const [{ n }] = await db
        .select({ n: count() })
        .from(links)
        .where(eq(links.domain_id, domain_id))
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
    const rows = await domainQuery(c.var.db).orderBy(asc(domains.host)).limit(limit).offset(offset)
    const [{ total }] = await c.var.db.select({ total: count() }).from(domains)
    return c.json({ data: rows.map(toDomain), total, limit, offset })
  })

  .post("/", validate("json", domainCreateSchema), async (c) => {
    assertRole(c.var.principal, "admin")
    const body = c.req.valid("json")

    const [row] = await c.var.db
      .insert(domains)
      .values({
        id: Bun.randomUUIDv7(),
        host: body.host,
        fallback_url: body.fallback_url ?? null,
        base_path_redirect: body.base_path_redirect ?? null,
        invalid_short_url_redirect: body.invalid_short_url_redirect ?? null,
      })
      .onConflictDoNothing({ target: domains.host })
      .returning()
    if (!row) throw ApiError.conflict(`domain ${body.host} already exists`)

    // Clears the negative entry a request to this host left behind while it 404'd.
    await c.var.cache.del(domainKey(row.host))
    await c.var.caddy.upsert(row.id, row.host)
    return c.json(toDomain({ domain: row, link_count: 0 }), 201)
  })

  .get("/:id", idParam, async (c) => c.json(await fetchDomain(c.var.db, c.req.valid("param").id)))

  .patch("/:id", idParam, validate("json", domainPatchSchema), async (c) => {
    assertRole(c.var.principal, "admin")
    const { id } = c.req.valid("param")
    const patch = c.req.valid("json")

    const before = await fetchDomain(c.var.db, id)

    if (patch.status === "archived") {
      // The check and the update are one transaction under a row lock, not
      // because the transaction itself would close the race under READ
      // COMMITTED (it would not), but because FOR UPDATE conflicts with
      // POST /links's FOR SHARE on the same domain row. That is what
      // serialises the two requests; do not simplify this to a plain
      // transaction. See plans/Plan_26.md §A2.
      await c.var.db.transaction(async (tx) => {
        await tx.select().from(domains).where(eq(domains.id, id)).for("update")
        await assertNoLinks(tx, id)
        await tx
          .update(domains)
          .set({ ...patch, updated_at: new Date() })
          .where(eq(domains.id, id))
      })
    } else {
      await c.var.db
        .update(domains)
        .set({ ...patch, updated_at: new Date() })
        .where(eq(domains.id, id))
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
    assertRole(c.var.principal, "admin")
    const { id } = c.req.valid("param")

    const before = await fetchDomain(c.var.db, id)

    // See the identical lock in PATCH /:id above — same race, same fix.
    await c.var.db.transaction(async (tx) => {
      await tx.select().from(domains).where(eq(domains.id, id)).for("update")
      await assertNoLinks(tx, id)
      await tx
        .update(domains)
        .set({ status: "archived", updated_at: new Date() })
        .where(eq(domains.id, id))
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

    await c.var.db.transaction(async (tx) => {
      await tx.select().from(domains).where(eq(domains.id, id)).for("update")
      await assertNoLinks(tx, id)
      try {
        await span("domain.purge", async () => tx.delete(domains).where(eq(domains.id, id)), {
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
