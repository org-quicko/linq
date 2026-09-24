import {
  ApiError,
  destinationTitle,
  type Link,
  linkCountQuerySchema,
  linkCreateSchema,
  linkListQuerySchema,
  linkPatchSchema,
  uuidSchema,
} from "@linq/shared"
import { sql, type Insertable, type Selectable, type SqlBool } from "kysely"
import { Hono } from "hono"
import { z } from "zod"
import {
  assertCanArchive,
  assertCanEdit,
  assertCanPurge,
  assertCan,
} from "../../auth/permissions.ts"
import { linkKeys } from "../../cache.ts"
import { isReservedSlug } from "../../config.ts"
import type { Db } from "../../db/client.ts"
import type { DB } from "../../db/types.generated.ts"
import { span } from "../../log.ts"
import { randomSlug } from "../../slug.ts"
import type { Env } from "../env.ts"
import { validate } from "../validate.ts"

const idParam = validate("param", z.object({ id: uuidSchema }))

type LinkRow = Selectable<DB["links"]> & {
  domain_host: string
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
  return {
    id: row.id,
    domain_id: row.domain_id,
    domain_host: row.domain_host,
    slug: row.slug,
    short_url: shortUrl(row.domain_host, row.slug),
    destination: row.destination,
    name: row.name,
    description: row.description,
    icon_url: row.icon_url,
    tags: row.tags,
    forward_query: row.forward_query,
    preset_params: row.preset_params,
    status: row.status,
    human_visits: row.human_visits,
    bot_visits: row.bot_visits,
    expires_at: row.expires_at?.toISOString() ?? null,
    listed: row.listed,
    rule_count: row.rule_count,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
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
    .selectFrom("links")
    .innerJoin("domains", "domains.id", "links.domain_id")
    .leftJoin("visit_counts", "visit_counts.link_id", "links.id")
    .selectAll("links")
    .select([
      "domains.host as domain_host",
      sql<number>`coalesce(visit_counts.human, 0)`.as("human_visits"),
      sql<number>`coalesce(visit_counts.bot, 0)`.as("bot_visits"),
      // A correlated subquery, not a join: `rules` is 1:N and every other join
      // here is 1:1, so joining it directly would multiply rows.
      sql<number>`(select count(*) from rules where rules.link_id = links.id)`.as("rule_count"),
    ])

  return {
    query,
    total: sql<number>`coalesce(visit_counts.human, 0) + coalesce(visit_counts.bot, 0)`,
  }
}

/** Loads one link as a complete API response, joins and visit totals included, or throws 404. */
function fetchLink(db: Db, id: string): Promise<Link> {
  return span(
    "link.fetch",
    async () => {
      const row = await linkQuery(db).query.where("links.id", "=", id).limit(1).executeTakeFirst()
      if (!row) throw ApiError.notFound("link")
      return toLink(row)
    },
    { in: { link_id: id }, out: (link) => ({ slug: link.slug, status: link.status }) },
  )
}

/** The raw row, for permission checks that run before the response is built. */
export function loadLink(db: Db, id: string): Promise<Selectable<DB["links"]>> {
  return span(
    "link.load",
    async () => {
      const row = await db.selectFrom("links").selectAll().where("id", "=", id).limit(1).executeTakeFirst()
      if (!row) throw ApiError.notFound("link")
      return row
    },
    { in: { link_id: id }, out: (link) => ({ status: link.status }) },
  )
}

/**
 * Lets the database settle slug races: `onConflictDoNothing` returns no row when
 * the slug was taken, so two concurrent creates can never both claim one slug.
 * Archived links keep their slug, so a retry never resurrects a dead link.
 */
function insertLink(
  db: Db,
  values: Omit<Insertable<DB["links"]>, "id" | "slug">,
  opts: { slug?: string; slugLength: number; clientBasePath: string },
): Promise<Selectable<DB["links"]>> {
  return span(
    "link.insert",
    async () => {
      const attempts = opts.slug ? 1 : 5
      for (let i = 0; i < attempts; i++) {
        const slug = opts.slug ?? randomSlug(opts.slugLength)
        if (isReservedSlug(slug, opts.clientBasePath)) continue
        const row = await db
          .insertInto("links")
          .values({
            ...values,
            id: Bun.randomUUIDv7(),
            slug,
          })
          .onConflict((oc) => oc.columns(["domain_id", "slug"]).doNothing())
          .returningAll()
          .executeTakeFirst()
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

    let filtered = query
    if (q.status !== "all") filtered = filtered.where("links.status", "=", q.status)
    if (q.domain_id.length) filtered = filtered.where("links.domain_id", "in", q.domain_id)
    if (q.tags.length) filtered = filtered.where(sql<SqlBool>`links.tags && ${sql.val(q.tags)}::text[]`)
    if (q.search) {
      const term = `%${q.search}%`
      filtered = filtered.where((eb) =>
        eb.or([eb("links.slug", "ilike", term), eb("links.name", "ilike", term), eb("links.destination", "ilike", term)]),
      )
    }
    // The app clock, so the list agrees with the redirect on what "expired"
    // means. References only `links` columns: the `total` count below joins
    // nothing, so a filter touching a joined table would break it.
    if (q.expiry !== "any") {
      const now = new Date()
      filtered =
        q.expiry === "expired"
          ? filtered.where("links.expires_at", "is not", null).where("links.expires_at", "<=", now)
          : filtered.where((eb) => eb.or([eb("links.expires_at", "is", null), eb("links.expires_at", ">", now)]))
    }

    // Every sortable column in one place; `visits` is the joined expression
    // rather than a column, which is why this is a map and not a field name.
    const sortable = {
      created_at: "links.created_at",
      updated_at: "links.updated_at",
      visits: total,
    } as const
    const direction = q.order
    const rows = await filtered
      // `links.id` is a UUIDv7, so the tiebreak is chronological rather than
      // arbitrary — and without it equal sort keys make paging
      // non-deterministic: a row can appear on two pages or on none.
      .orderBy(sortable[q.sort], direction)
      .orderBy("links.id", direction)
      .limit(q.limit)
      .offset(q.offset)
      .execute()

    let countQuery = c.var.db.selectFrom("links").select((eb) => eb.fn.countAll<number>().as("total"))
    if (q.status !== "all") countQuery = countQuery.where("status", "=", q.status)
    if (q.domain_id.length) countQuery = countQuery.where("domain_id", "in", q.domain_id)
    if (q.tags.length) countQuery = countQuery.where(sql<SqlBool>`tags && ${sql.val(q.tags)}::text[]`)
    if (q.search) {
      const term = `%${q.search}%`
      countQuery = countQuery.where((eb) => eb.or([eb("slug", "ilike", term), eb("name", "ilike", term), eb("destination", "ilike", term)]))
    }
    if (q.expiry !== "any") {
      const now = new Date()
      countQuery = q.expiry === "expired"
        ? countQuery.where("expires_at", "is not", null).where("expires_at", "<=", now)
        : countQuery.where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]))
    }
    const { total: matched = 0 } = (await countQuery.executeTakeFirst()) ?? {}

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
    let countQuery = c.var.db.selectFrom("links").select((eb) => eb.fn.countAll<number>().as("total"))
    if (q.status !== "all") countQuery = countQuery.where("status", "=", q.status)
    const { total = 0 } = (await countQuery.executeTakeFirst()) ?? {}
    return c.json({ total })
  })

  .post("/", validate("json", linkCreateSchema), async (c) => {
    assertCan(c.var.principal, "create", "Link")
    const body = c.req.valid("json")
    if (body.slug && isReservedSlug(body.slug, c.var.config.LINQ_CLIENT_BASE_PATH)) {
      throw ApiError.validation("request validation failed", [
        { code: "custom", path: ["slug"], message: "slug is reserved" },
      ])
    }
    const fetched = await c.var.metadata.fetch(body.destination)

    // FOR SHARE conflicts with the archiver's FOR UPDATE (domains.ts's
    // archive transactions) but not with itself, so concurrent creates on
    // one domain still run in parallel and only an in-flight archive blocks
    // them. Without this lock, a plain transaction would not close the race
    // under READ COMMITTED.
    const row = await c.var.db.transaction().execute(async (tx) => {
      const domain = await tx
        .selectFrom("domains")
        .selectAll()
        .where("id", "=", body.domain_id)
        .forShare()
        .limit(1)
        .executeTakeFirst()
      if (!domain) throw ApiError.notFound("domain")
      if (domain.status === "archived") throw ApiError.conflict("domain is archived")

      const linkRow = await insertLink(
        tx,
        {
          domain_id: body.domain_id,
          destination: body.destination,
          // A link should always have a useful label even when metadata
          // fetching is disabled (the secure default) or the page has no
          // title. A caller-supplied name remains authoritative.
          name: body.name ?? fetched.name ?? destinationTitle(body.destination),
          description: body.description ?? fetched.description ?? null,
          icon_url: fetched.icon_url,
          tags: body.tags,
          forward_query: body.forward_query,
          preset_params: body.preset_params,
          expires_at: body.expires_at ? new Date(body.expires_at) : null,
          listed: body.listed,
        },
        {
          slug: body.slug,
          slugLength: c.var.config.LINQ_SLUG_LENGTH,
          clientBasePath: c.var.config.LINQ_CLIENT_BASE_PATH,
        },
      )

      if (body.rules && body.rules.length > 0) {
        await tx.insertInto("rules").values(
          body.rules.map((rule, position) => ({
            id: Bun.randomUUIDv7(),
            link_id: linkRow.id,
            position,
            destination: rule.destination,
            conditions: JSON.stringify(rule.conditions),
          })),
        ).execute()
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
    // Archiving or restoring (a status change) is admin-only; every other
    // field is an ordinary edit. See docs/adr/0016.
    if (patch.status !== undefined) {
      assertCanArchive(c.var.principal)
    } else {
      assertCanEdit(c.var.principal)
    }

    const fetched =
      patch.destination !== undefined ? await c.var.metadata.fetch(patch.destination) : null

    await c.var.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("links")
        .set({
          // Spelled out rather than a blanket `...patch` spread: `expires_at`
          // arrives as an ISO string and the column takes a Date, so the spread
          // would not typecheck. See keys.ts's PATCH for the same pattern.
          ...(patch.destination !== undefined ? { destination: patch.destination } : {}),
          ...(patch.name !== undefined
            ? { name: patch.name }
            : fetched
              ? { name: fetched.name ?? existing.name ?? destinationTitle(patch.destination!) }
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
          ...(patch.expires_at !== undefined
            ? { expires_at: patch.expires_at ? new Date(patch.expires_at) : null }
            : {}),
          ...(patch.listed !== undefined ? { listed: patch.listed } : {}),
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .execute()

      if (patch.rules !== undefined) {
        await tx.deleteFrom("rules").where("link_id", "=", id).execute()
        if (patch.rules.length > 0) {
          await tx.insertInto("rules").values(
            patch.rules.map((rule, position) => ({
              id: Bun.randomUUIDv7(),
              link_id: id,
              position,
              destination: rule.destination,
              conditions: JSON.stringify(rule.conditions),
            })),
          ).execute()
        }
      }
    })
    await c.var.cache.del(...linkKeys(existing.domain_id, existing.slug))
    return c.json(await fetchLink(c.var.db, id))
  })

  /**
   * Bulk analogue of `/:id/purge` below — "Empty archive" destroys every
   * archived link in one call instead of the client firing one DELETE per
   * row. Registered ahead of `/:id` for the same reason as `/count` above:
   * both are literal segments a param route could otherwise swallow.
   *
   * No filters beyond `status = archived`: purging is only ever "every
   * archived link", the same invariant `/:id/purge` already enforces one row
   * at a time, so there is nothing else for a caller to scope this to.
   */
  .delete("/purge", async (c) => {
    assertCanPurge(c.var.principal)

    const rows = await span(
      "link.purgeAll",
      () =>
        c.var.db
          .deleteFrom("links")
          .where("status", "=", "archived")
          .returning(["domain_id", "slug"])
          .execute(),
      { out: (deleted) => ({ purged: deleted.length }) },
    )

    await c.var.cache.del(...rows.flatMap((r) => linkKeys(r.domain_id, r.slug)))
    return c.json({ purged: rows.length })
  })

  /** DELETE is an alias for archiving; links are never dropped. See docs/adr/0002.
   *  Admin only, same as restoring one — see docs/adr/0016. */
  .delete("/:id", idParam, async (c) => {
    const { id } = c.req.valid("param")
    const existing = await loadLink(c.var.db, id)
    assertCanArchive(c.var.principal)

    await c.var.db
      .updateTable("links")
      .set({ status: "archived", updated_at: new Date() })
      .where("id", "=", id)
      .execute()
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

    await span("link.purge", async () => c.var.db.deleteFrom("links").where("id", "=", id).execute(), {
      in: { link_id: id, slug: existing.slug },
    })
    await c.var.cache.del(...linkKeys(existing.domain_id, existing.slug))
    return c.body(null, 204)
  })

/** Tags are derived from active links; there is no tag table to keep in step. */
export const tagRoutes = new Hono<Env>().get("/", async (c) => {
  const expanded = c.var.db
    .selectFrom("links")
    .select(sql<string>`unnest(tags)`.as("tag"))
    .where("status", "=", "active")
    .as("expanded")

  const rows = await c.var.db
    .selectFrom(expanded)
    .select(["expanded.tag as tag", (eb) => eb.fn.countAll<number>().as("count")])
    .groupBy("expanded.tag")
    .orderBy("count", "desc")
    .orderBy("expanded.tag")
    .execute()

  return c.json(rows)
})
