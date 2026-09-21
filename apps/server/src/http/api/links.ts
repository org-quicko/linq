import {
  ApiError,
  can,
  type Link,
  linkCountQuerySchema,
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
  inArray,
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
import { apiKeys, domains, links, rules, visitCounts } from "../../db/schema.ts"
import { span } from "../../log.ts"
import { randomSlug } from "../../slug.ts"
import type { Env } from "../env.ts"
import { validate } from "../validate.ts"

const idParam = validate("param", z.object({ id: uuidSchema }))

type LinkRow = {
  link: typeof links.$inferSelect
  domain_host: string
  owner_name: string | null
  human_visits: number
  bot_visits: number
  rule_count: number
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
    domain_id: link.domain_id,
    domain_host: row.domain_host,
    slug: link.slug,
    short_url: shortUrl(row.domain_host, link.slug),
    destination: link.destination,
    name: link.name,
    description: link.description,
    icon_url: link.icon_url,
    tags: link.tags,
    forward_query: link.forward_query,
    preset_params: link.preset_params,
    status: link.status,
    owner_id: link.owner_id,
    owner_name: row.owner_name,
    human_visits: row.human_visits,
    bot_visits: row.bot_visits,
    expires_at: link.expires_at?.toISOString() ?? null,
    listed: link.listed,
    rule_count: row.rule_count,
    created_at: link.created_at.toISOString(),
    updated_at: link.updated_at.toISOString(),
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
      domain_host: domains.host,
      owner_name: apiKeys.name,
      human_visits: sql<number>`coalesce(${visitCounts.human}, 0)`.mapWith(Number),
      bot_visits: sql<number>`coalesce(${visitCounts.bot}, 0)`.mapWith(Number),
      // A correlated subquery, not a join: `rules` is 1:N and every other join
      // here is 1:1, so joining it directly would multiply rows.
      rule_count:
        sql<number>`(select count(*) from ${rules} where ${rules.link_id} = ${links.id})`.mapWith(
          Number,
        ),
    })
    .from(links)
    .innerJoin(domains, eq(domains.id, links.domain_id))
    .leftJoin(apiKeys, eq(apiKeys.id, links.owner_id))
    .leftJoin(visitCounts, eq(visitCounts.link_id, links.id))

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
    { in: { link_id: id }, out: (link) => ({ slug: link.slug, status: link.status }) },
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
    { in: { link_id: id }, out: (link) => ({ owner_id: link.owner_id, status: link.status }) },
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
          .onConflictDoNothing({ target: [links.domain_id, links.slug] })
          .returning()
        // The attempt count is the signal that LINQ_SLUG_LENGTH is running out.
        if (row) return { row, attempts: i + 1 }
      }
      if (opts.slug) throw ApiError.conflict(`slug "${opts.slug}" is taken on this domain`)
      throw ApiError.conflict("could not allocate a free slug; raise LINQ_SLUG_LENGTH")
    },
    {
      in: { domain_id: values.domain_id, slug: opts.slug ?? null },
      out: ({ row, attempts }) => ({ link_id: row.id, slug: row.slug, attempts }),
    },
  ).then(({ row }) => row)
}

export const linkRoutes = new Hono<Env>()
  .get("/", validate("query", linkListQuerySchema), async (c) => {
    const q = c.req.valid("query")
    const { query, total } = linkQuery(c.var.db)

    const filters: SQL[] = []
    if (q.status !== "all") filters.push(eq(links.status, q.status))
    if (q.domain_id.length) filters.push(inArray(links.domain_id, q.domain_id))
    if (q.owner_id) filters.push(eq(links.owner_id, q.owner_id))
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
          ? (and(isNotNull(links.expires_at), lte(links.expires_at, now)) as SQL)
          : (or(isNull(links.expires_at), gt(links.expires_at, now)) as SQL),
      )
    }
    const where = filters.length ? and(...filters) : undefined

    // Every sortable column in one place; `visits` is the joined expression
    // rather than a column, which is why this is a map and not a field name.
    const sortable = {
      created_at: links.created_at,
      updated_at: links.updated_at,
      visits: total,
    } as const
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

  /**
   * Just the count — no rows, no joins. Registered ahead of `/:id` so "count"
   * is never swallowed by that route's uuid param. The client's sidebar
   * badges are what this is for: reading `total` off `GET /` would work too,
   * but at the cost of fetching (and joining across three tables for) a row
   * neither badge displays.
   */
  .get("/count", validate("query", linkCountQuerySchema), async (c) => {
    const q = c.req.valid("query")
    const where = q.status !== "all" ? eq(links.status, q.status) : undefined
    const [{ total }] = await c.var.db.select({ total: count() }).from(links).where(where)
    return c.json({ total })
  })

  .post("/", validate("json", linkCreateSchema), async (c) => {
    assertRole(c.var.principal, "author")
    const body = c.req.valid("json")
    const fetched = await c.var.metadata.fetch(body.destination)

    // FOR SHARE conflicts with the archiver's FOR UPDATE (domains.ts's
    // archive transactions) but not with itself, so concurrent creates on
    // one domain still run in parallel and only an in-flight archive blocks
    // them. Without this lock, a plain transaction would not close the race
    // under READ COMMITTED. See plans/Plan_26.md §A2.
    const row = await c.var.db.transaction(async (tx) => {
      const [domain] = await tx
        .select()
        .from(domains)
        .where(eq(domains.id, body.domain_id))
        .for("share")
        .limit(1)
      if (!domain) throw ApiError.notFound("domain")
      if (domain.status === "archived") throw ApiError.conflict("domain is archived")

      const linkRow = await insertLink(
        tx,
        {
          domain_id: body.domain_id,
          destination: body.destination,
          name: body.name ?? fetched.name ?? null,
          description: body.description ?? fetched.description ?? null,
          icon_url: fetched.icon_url,
          tags: body.tags,
          forward_query: body.forward_query,
          preset_params: body.preset_params,
          owner_id: c.var.principal.keyId,
          expires_at: body.expires_at ? new Date(body.expires_at) : null,
          listed: body.listed,
        },
        { slug: body.slug, slugLength: c.var.config.LINQ_SLUG_LENGTH },
      )

      if (body.rules && body.rules.length > 0) {
        await tx.insert(rules).values(
          body.rules.map((rule, position) => ({
            id: Bun.randomUUIDv7(),
            link_id: linkRow.id,
            position,
            destination: rule.destination,
            conditions: rule.conditions,
          })),
        )
      }

      return linkRow
    })

    // Clears the negative entry left behind while this slug was 404ing.
    await c.var.cache.del(...linkKeys(row.domain_id, row.slug))
    return c.json(await fetchLink(c.var.db, row.id), 201)
  })

  .get("/:id", idParam, async (c) => c.json(await fetchLink(c.var.db, c.req.valid("param").id)))

  .patch("/:id", idParam, validate("json", linkPatchSchema), async (c) => {
    const { id } = c.req.valid("param")
    const patch = c.req.valid("json")
    const existing = await loadLink(c.var.db, id)
    assertCanEdit(c.var.principal, existing.owner_id)

    if (patch.owner_id !== undefined) {
      assertCanTransfer(c.var.principal, existing.owner_id)
      const [owner] = await c.var.db
        .select({ id: apiKeys.id, role: apiKeys.role })
        .from(apiKeys)
        .where(eq(apiKeys.id, patch.owner_id))
        .limit(1)
      if (!owner) throw ApiError.notFound("key")
      // Not 403: the caller is allowed, the *target* is not eligible.
      if (!can.ownLink(owner)) throw ApiError.conflict("a viewer key cannot own a link")
    }

    const fetched =
      patch.destination !== undefined ? await c.var.metadata.fetch(patch.destination) : null

    await c.var.db.transaction(async (tx) => {
      await tx
        .update(links)
        .set({
          // Spelled out rather than a blanket `...patch` spread: `expires_at`
          // arrives as an ISO string and the column takes a Date, so the spread
          // would not typecheck. See keys.ts's PATCH for the same pattern.
          ...(patch.destination !== undefined ? { destination: patch.destination } : {}),
          ...(patch.name !== undefined
            ? { name: patch.name }
            : fetched
              ? { name: fetched.name ?? existing.name }
              : {}),
          ...(patch.description !== undefined
            ? { description: patch.description }
            : fetched
              ? { description: fetched.description ?? existing.description }
              : {}),
          ...(fetched ? { icon_url: fetched.icon_url ?? existing.icon_url } : {}),
          ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
          ...(patch.forward_query !== undefined ? { forward_query: patch.forward_query } : {}),
          ...(patch.preset_params !== undefined ? { preset_params: patch.preset_params } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.owner_id !== undefined ? { owner_id: patch.owner_id } : {}),
          ...(patch.expires_at !== undefined
            ? { expires_at: patch.expires_at ? new Date(patch.expires_at) : null }
            : {}),
          ...(patch.listed !== undefined ? { listed: patch.listed } : {}),
          updated_at: new Date(),
        })
        .where(eq(links.id, id))

      if (patch.rules !== undefined) {
        await tx.delete(rules).where(eq(rules.link_id, id))
        if (patch.rules.length > 0) {
          await tx.insert(rules).values(
            patch.rules.map((rule, position) => ({
              id: Bun.randomUUIDv7(),
              link_id: id,
              position,
              destination: rule.destination,
              conditions: rule.conditions,
            })),
          )
        }
      }
    })
    await c.var.cache.del(...linkKeys(existing.domain_id, existing.slug))
    return c.json(await fetchLink(c.var.db, id))
  })

  /** DELETE is an alias for archiving; links are never dropped. See docs/adr/0002. */
  .delete("/:id", idParam, async (c) => {
    const { id } = c.req.valid("param")
    const existing = await loadLink(c.var.db, id)
    assertCanEdit(c.var.principal, existing.owner_id)

    await c.var.db
      .update(links)
      .set({ status: "archived", updated_at: new Date() })
      .where(eq(links.id, id))
    await c.var.cache.del(...linkKeys(existing.domain_id, existing.slug))
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
      in: { link_id: id, slug: existing.slug },
    })
    await c.var.cache.del(...linkKeys(existing.domain_id, existing.slug))
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
