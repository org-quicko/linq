import {
  ApiError,
  can,
  type Link,
  linkCreateSchema,
  linkListQuerySchema,
  linkPatchSchema,
  uuidSchema,
} from "@linq/shared"
import {
  and,
  arrayOverlaps,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  isNotNull,
  isNull,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import {
  assertCanEdit,
  assertCanPurge,
  assertCanTransfer,
  assertRole,
} from "../../auth/permissions.ts"
import { linkKeys } from "../../cache.ts"
import type { Db } from "../../db/client.ts"
import { apiKeys, domains, links, visitCounts } from "../../db/schema.ts"
import { span } from "../../log.ts"
import { randomSlug } from "../../slug.ts"
import type { Env } from "../env.ts"
import { validate } from "../validate.ts"

const idParam = validate("param", z.object({ id: uuidSchema }))

type LinkRow = {
  link: typeof links.$inferSelect
  domainHost: string
  ownerName: string | null
  humanVisits: number
  botVisits: number
}

/** A port only ever appears in a local setup, where no TLS terminator is in front. */
export function shortUrl(host: string, slug: string): string {
  const scheme = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? "http" : "https"
  return `${scheme}://${host}/${slug}`
}

/** Maps a joined link row to the JSON shape the API returns. */
function toLink(row: LinkRow): Link {
  const { link } = row
  return {
    id: link.id,
    domainId: link.domainId,
    domainHost: row.domainHost,
    slug: link.slug,
    shortUrl: shortUrl(row.domainHost, link.slug),
    destination: link.destination,
    name: link.name,
    tags: link.tags,
    forwardQuery: link.forwardQuery,
    presetParams: link.presetParams,
    status: link.status,
    ownerId: link.ownerId,
    ownerName: row.ownerName,
    humanVisits: row.humanVisits,
    botVisits: row.botVisits,
    expiresAt: link.expiresAt?.toISOString() ?? null,
    listed: link.listed,
    createdAt: link.createdAt.toISOString(),
    updatedAt: link.updatedAt.toISOString(),
  }
}

/**
 * Every link response carries its visit totals, so the joins live in one place.
 * `total` is exposed separately because `sort=visits` orders on it.
 *
 * The totals come off `visit_counts`, which a trigger keeps in step with the
 * visits table: one indexed row per link rather than an unbounded aggregate run
 * on every page of the list. See docs/adr/0007.
 */
function linkQuery(db: Db) {
  const query = db
    .select({
      link: links,
      domainHost: domains.host,
      ownerName: apiKeys.name,
      humanVisits: sql<number>`coalesce(${visitCounts.human}, 0)`.mapWith(Number),
      botVisits: sql<number>`coalesce(${visitCounts.bot}, 0)`.mapWith(Number),
    })
    .from(links)
    .innerJoin(domains, eq(domains.id, links.domainId))
    .leftJoin(apiKeys, eq(apiKeys.id, links.ownerId))
    .leftJoin(visitCounts, eq(visitCounts.linkId, links.id))

  return {
    query,
    total: sql`coalesce(${visitCounts.human}, 0) + coalesce(${visitCounts.bot}, 0)`,
  }
}

/** Loads one link as a complete API response, joins and visit totals included, or throws 404. */
function fetchLink(db: Db, id: string): Promise<Link> {
  return span(
    "link.fetch",
    async () => {
      const [row] = await linkQuery(db).query.where(eq(links.id, id)).limit(1)
      if (!row) throw ApiError.notFound("link")
      return toLink(row)
    },
    { in: { linkId: id }, out: (link) => ({ slug: link.slug, status: link.status }) },
  )
}

/** The raw row, for permission checks that run before the response is built. */
export function loadLink(db: Db, id: string): Promise<typeof links.$inferSelect> {
  return span(
    "link.load",
    async () => {
      const [row] = await db.select().from(links).where(eq(links.id, id)).limit(1)
      if (!row) throw ApiError.notFound("link")
      return row
    },
    { in: { linkId: id }, out: (link) => ({ ownerId: link.ownerId, status: link.status }) },
  )
}

/**
 * Lets the database settle slug races: `onConflictDoNothing` returns no row when
 * the slug was taken, so two concurrent creates can never both claim one slug.
 * Archived links keep their slug, so a retry never resurrects a dead link.
 */
function insertLink(
  db: Db,
  values: Omit<typeof links.$inferInsert, "id" | "slug">,
  opts: { slug?: string; slugLength: number },
): Promise<typeof links.$inferSelect> {
  return span(
    "link.insert",
    async () => {
      const attempts = opts.slug ? 1 : 5
      for (let i = 0; i < attempts; i++) {
        const [row] = await db
          .insert(links)
          .values({
            ...values,
            id: Bun.randomUUIDv7(),
            slug: opts.slug ?? randomSlug(opts.slugLength),
          })
          .onConflictDoNothing({ target: [links.domainId, links.slug] })
          .returning()
        // The attempt count is the signal that LINQ_SLUG_LENGTH is running out.
        if (row) return { row, attempts: i + 1 }
      }
      if (opts.slug) throw ApiError.conflict(`slug "${opts.slug}" is taken on this domain`)
      throw ApiError.conflict("could not allocate a free slug; raise LINQ_SLUG_LENGTH")
    },
    {
      in: { domainId: values.domainId, slug: opts.slug ?? null },
      out: ({ row, attempts }) => ({ linkId: row.id, slug: row.slug, attempts }),
    },
  ).then(({ row }) => row)
}

export const linkRoutes = new Hono<Env>()
  .get("/", validate("query", linkListQuerySchema), async (c) => {
    const q = c.req.valid("query")
    const { query, total } = linkQuery(c.var.db)

    const filters: SQL[] = []
    if (q.status !== "all") filters.push(eq(links.status, q.status))
    if (q.domainId) filters.push(eq(links.domainId, q.domainId))
    if (q.ownerId) filters.push(eq(links.ownerId, q.ownerId))
    if (q.tags.length) filters.push(arrayOverlaps(links.tags, q.tags))
    if (q.search) {
      const term = `%${q.search}%`
      filters.push(
        or(ilike(links.slug, term), ilike(links.name, term), ilike(links.destination, term)) as SQL,
      )
    }
    // The app clock, so the list agrees with the redirect on what "expired"
    // means. References only `links` columns: the `total` count below joins
    // nothing, so a filter touching a joined table would break it.
    if (q.expiry !== "any") {
      const now = new Date()
      filters.push(
        q.expiry === "expired"
          ? (and(isNotNull(links.expiresAt), lte(links.expiresAt, now)) as SQL)
          : (or(isNull(links.expiresAt), gt(links.expiresAt, now)) as SQL),
      )
    }
    const where = filters.length ? and(...filters) : undefined

    // Every sortable column in one place; `visits` is the joined expression
    // rather than a column, which is why this is a map and not a field name.
    const sortable = { createdAt: links.createdAt, updatedAt: links.updatedAt, visits: total } as const
    const direction = q.order === "asc" ? asc : desc
    const rows = await query
      .where(where)
      // `links.id` is a UUIDv7, so the tiebreak is chronological rather than
      // arbitrary — and without it equal sort keys make paging
      // non-deterministic: a row can appear on two pages or on none.
      .orderBy(direction(sortable[q.sort]), direction(links.id))
      .limit(q.limit)
      .offset(q.offset)

    const [{ total: matched }] = await c.var.db.select({ total: count() }).from(links).where(where)

    return c.json({ data: rows.map(toLink), total: matched, limit: q.limit, offset: q.offset })
  })

  .post("/", validate("json", linkCreateSchema), async (c) => {
    assertRole(c.var.principal, "author")
    const body = c.req.valid("json")

    // FOR SHARE conflicts with the archiver's FOR UPDATE (domains.ts's
    // archive transactions) but not with itself, so concurrent creates on
    // one domain still run in parallel and only an in-flight archive blocks
    // them. Without this lock, a plain transaction would not close the race
    // under READ COMMITTED. See plans/Plan_26.md §A2.
    const row = await c.var.db.transaction(async (tx) => {
      const [domain] = await tx
        .select()
        .from(domains)
        .where(eq(domains.id, body.domainId))
        .for("share")
        .limit(1)
      if (!domain) throw ApiError.notFound("domain")
      if (domain.status === "archived") throw ApiError.conflict("domain is archived")

      return insertLink(
        tx,
        {
          domainId: body.domainId,
          destination: body.destination,
          name: body.name ?? null,
          tags: body.tags,
          forwardQuery: body.forwardQuery,
          presetParams: body.presetParams,
          ownerId: c.var.principal.keyId,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
          listed: body.listed,
        },
        { slug: body.slug, slugLength: c.var.config.LINQ_SLUG_LENGTH },
      )
    })

    // Clears the negative entry left behind while this slug was 404ing.
    await c.var.cache.del(...linkKeys(row.domainId, row.slug))
    return c.json(await fetchLink(c.var.db, row.id), 201)
  })

  .get("/:id", idParam, async (c) => c.json(await fetchLink(c.var.db, c.req.valid("param").id)))

  .patch("/:id", idParam, validate("json", linkPatchSchema), async (c) => {
    const { id } = c.req.valid("param")
    const patch = c.req.valid("json")
    const existing = await loadLink(c.var.db, id)
    assertCanEdit(c.var.principal, existing.ownerId)

    if (patch.ownerId !== undefined) {
      assertCanTransfer(c.var.principal, existing.ownerId)
      const [owner] = await c.var.db
        .select({ id: apiKeys.id, role: apiKeys.role })
        .from(apiKeys)
        .where(eq(apiKeys.id, patch.ownerId))
        .limit(1)
      if (!owner) throw ApiError.notFound("key")
      // Not 403: the caller is allowed, the *target* is not eligible.
      if (!can.ownLink(owner)) throw ApiError.conflict("a viewer key cannot own a link")
    }

    await c.var.db
      .update(links)
      .set({
        // Spelled out rather than a blanket `...patch` spread: `expiresAt`
        // arrives as an ISO string and the column takes a Date, so the spread
        // would not typecheck. See keys.ts's PATCH for the same pattern.
        ...(patch.destination !== undefined ? { destination: patch.destination } : {}),
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        ...(patch.forwardQuery !== undefined ? { forwardQuery: patch.forwardQuery } : {}),
        ...(patch.presetParams !== undefined ? { presetParams: patch.presetParams } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.ownerId !== undefined ? { ownerId: patch.ownerId } : {}),
        ...(patch.expiresAt !== undefined
          ? { expiresAt: patch.expiresAt ? new Date(patch.expiresAt) : null }
          : {}),
        ...(patch.listed !== undefined ? { listed: patch.listed } : {}),
        updatedAt: new Date(),
      })
      .where(eq(links.id, id))
    await c.var.cache.del(...linkKeys(existing.domainId, existing.slug))
    return c.json(await fetchLink(c.var.db, id))
  })

  /** DELETE is an alias for archiving; links are never dropped. See docs/adr/0002. */
  .delete("/:id", idParam, async (c) => {
    const { id } = c.req.valid("param")
    const existing = await loadLink(c.var.db, id)
    assertCanEdit(c.var.principal, existing.ownerId)

    await c.var.db
      .update(links)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(links.id, id))
    await c.var.cache.del(...linkKeys(existing.domainId, existing.slug))
    return c.json(await fetchLink(c.var.db, id))
  })

  /**
   * Destroys an archived link for good. Admin only, and archived-first, so a live
   * short URL can never be destroyed by one call. Rules and visits go with it —
   * `visits.link_id` is `ON DELETE CASCADE`, so a link's own traffic is
   * destroyed, not reclassified as orphan traffic.
   *
   * Unlike archiving, this **releases the slug** for reuse on that domain. See
   * docs/adr/0002.
   */
  .delete("/:id/purge", idParam, async (c) => {
    assertCanPurge(c.var.principal)
    const { id } = c.req.valid("param")
    const existing = await loadLink(c.var.db, id)
    if (existing.status !== "archived") {
      throw ApiError.conflict("archive the link before purging it")
    }

    await span("link.purge", async () => c.var.db.delete(links).where(eq(links.id, id)), {
      in: { linkId: id, slug: existing.slug },
    })
    await c.var.cache.del(...linkKeys(existing.domainId, existing.slug))
    return c.body(null, 204)
  })

/** Tags are derived from active links; there is no tag table to keep in step. */
export const tagRoutes = new Hono<Env>().get("/", async (c) => {
  const expanded = c.var.db
    .select({ tag: sql<string>`unnest(${links.tags})`.as("tag") })
    .from(links)
    .where(eq(links.status, "active"))
    .as("expanded")

  const rows = await c.var.db
    .select({ tag: expanded.tag, count: count() })
    .from(expanded)
    .groupBy(expanded.tag)
    .orderBy(desc(count()), asc(expanded.tag))

  return c.json(rows)
})
