import {
  ApiError,
  type Domain,
  domainCreateSchema,
  domainPatchSchema,
  paginationSchema,
  uuidSchema,
} from "@linq/shared"
import { and, asc, count, eq, sql } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import { assertCanPurge, assertRole } from "../../auth/permissions.ts"
import type { Db } from "../../db/client.ts"
import { domains, links } from "../../db/schema.ts"
import { span } from "../../log.ts"
import type { Env } from "../env.ts"
import { validate } from "../validate.ts"

const idParam = validate("param", z.object({ id: uuidSchema }))

type DomainRow = { domain: typeof domains.$inferSelect; linkCount: number }

/** Maps a domain row and its active-link count to the JSON shape the API returns. */
function toDomain({ domain, linkCount }: DomainRow): Domain {
  return {
    id: domain.id,
    host: domain.host,
    fallbackUrl: domain.fallbackUrl,
    status: domain.status,
    linkCount,
    createdAt: domain.createdAt.toISOString(),
    updatedAt: domain.updatedAt.toISOString(),
  }
}

/**
 * Active links per domain. Archived ones are excluded because this count is what
 * decides whether the domain may be archived.
 */
function domainQuery(db: Db) {
  const counts = db
    .select({ domainId: links.domainId, n: sql<number>`count(*)`.as("n") })
    .from(links)
    .where(eq(links.status, "active"))
    .groupBy(links.domainId)
    .as("link_counts")

  return db
    .select({
      domain: domains,
      linkCount: sql<number>`coalesce(${counts.n}, 0)`.mapWith(Number),
    })
    .from(domains)
    .leftJoin(counts, eq(counts.domainId, domains.id))
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
    { in: { domainId: id }, out: (domain) => ({ host: domain.host, status: domain.status }) },
  )
}

/**
 * A purge takes the domain's clicks with it (`clicks.domain_id` is NOT NULL, so
 * they have nowhere to go), so it is refused while **any** link row still points
 * at the domain — archived ones included, unlike the archive check above.
 */
function assertNoLinksAtAll(db: Db, domainId: string): Promise<void> {
  return span(
    "domain.assertNoLinksAtAll",
    async () => {
      const [remaining] = await db
        .select({ id: links.id })
        .from(links)
        .where(eq(links.domainId, domainId))
        .limit(1)
      if (remaining) {
        throw ApiError.conflict("domain still has links; purge them first")
      }
    },
    { in: { domainId } },
  )
}

/** An archived domain stops serving, so it may never strand an active link. */
function assertNoActiveLinks(db: Db, domainId: string): Promise<void> {
  return span(
    "domain.assertNoActiveLinks",
    async () => {
      const [stranded] = await db
        .select({ id: links.id })
        .from(links)
        .where(and(eq(links.domainId, domainId), eq(links.status, "active")))
        .limit(1)
      if (stranded) {
        throw ApiError.conflict("domain still has active links; archive them first")
      }
    },
    { in: { domainId } },
  )
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
      .values({ id: Bun.randomUUIDv7(), host: body.host, fallbackUrl: body.fallbackUrl ?? null })
      .onConflictDoNothing({ target: domains.host })
      .returning()
    if (!row) throw ApiError.conflict(`domain ${body.host} already exists`)

    return c.json(toDomain({ domain: row, linkCount: 0 }), 201)
  })

  .get("/:id", idParam, async (c) => c.json(await fetchDomain(c.var.db, c.req.valid("param").id)))

  .patch("/:id", idParam, validate("json", domainPatchSchema), async (c) => {
    assertRole(c.var.principal, "admin")
    const { id } = c.req.valid("param")
    const patch = c.req.valid("json")

    await fetchDomain(c.var.db, id)
    if (patch.status === "archived") await assertNoActiveLinks(c.var.db, id)

    await c.var.db
      .update(domains)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(domains.id, id))
    return c.json(await fetchDomain(c.var.db, id))
  })

  /** DELETE is an alias for archiving; domains are never dropped. See docs/adr/0002. */
  .delete("/:id", idParam, async (c) => {
    assertRole(c.var.principal, "admin")
    const { id } = c.req.valid("param")

    await fetchDomain(c.var.db, id)
    await assertNoActiveLinks(c.var.db, id)

    await c.var.db
      .update(domains)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(domains.id, id))
    return c.json(await fetchDomain(c.var.db, id))
  })

  /**
   * Destroys an archived, empty domain for good, and its clicks with it. Admin
   * only, and archived-first. See docs/adr/0002.
   */
  .delete("/:id/purge", idParam, async (c) => {
    assertCanPurge(c.var.principal)
    const { id } = c.req.valid("param")

    const domain = await fetchDomain(c.var.db, id)
    if (domain.status !== "archived") {
      throw ApiError.conflict("archive the domain before purging it")
    }
    await assertNoLinksAtAll(c.var.db, id)

    await span("domain.purge", async () => c.var.db.delete(domains).where(eq(domains.id, id)), {
      in: { domainId: id, host: domain.host },
    })
    return c.body(null, 204)
  })
