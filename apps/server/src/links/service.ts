import {
  ApiError,
  destinationTitle,
  type Link,
  type LinkCount,
  type LinkPurgeResult,
  type linkCountQuerySchema,
  type linkCreateSchema,
  type linkListQuerySchema,
  type linkPatchSchema,
  type Page,
} from "@linq/shared"
import { sql, type Insertable, type Selectable, type SqlBool } from "kysely"
import type { z } from "zod"
import type { Principal } from "../auth/middleware.ts"
import { assertCan, assertCanArchive, assertCanEdit, assertCanPurge } from "../auth/permissions.ts"
import { linkKeys } from "../infra/cache.ts"
import { isReservedSlug } from "../infra/config.ts"
import type { Db } from "../infra/db/client.ts"
import type { DB } from "../infra/db/types.generated.ts"
import type { Deps } from "../deps.ts"
import { span } from "../infra/log.ts"
import { randomSlug } from "./slug.ts"

type LinkListQuery = z.infer<typeof linkListQuerySchema>
type LinkCountQuery = z.infer<typeof linkCountQuerySchema>
type LinkCreate = z.infer<typeof linkCreateSchema>
type LinkPatch = z.infer<typeof linkPatchSchema>

type LinkRow = Selectable<DB["links"]> & {
  domain_host: string
  human_visits: number
  bot_visits: number
  rule_count: number
  tags: string[]
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
 * on every page of the list. See resources/docs/adr/0007.
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
      // Same reason: `link_tags` is 1:N. Sorted so the order is stable across reads.
      sql<string[]>`coalesce((
        select array_agg(tags.name order by tags.name)
        from link_tags join tags on tags.id = link_tags.tag_id
        where link_tags.link_id = links.id
      ), '{}')`.as("tags"),
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
 * Replaces a link's tags, dropping duplicates. The ids
 * are re-read rather than taken from `returning`: `doNothing` returns no row
 * for a tag that already exists. A concurrent insert of the same new tag
 * blocks on the unique constraint until the other transaction settles, and the
 * select that follows is a new statement, so it sees that commit.
 */
async function setLinkTags(db: Db, linkId: string, names: string[]): Promise<void> {
  const unique = [...new Set(names)]
  await db.deleteFrom("link_tags").where("link_id", "=", linkId).execute()
  if (unique.length === 0) return
  await db
    .insertInto("tags")
    .values(unique.map((name) => ({ id: Bun.randomUUIDv7(), name })))
    .onConflict((oc) => oc.column("name").doNothing())
    .execute()
  const rows = await db.selectFrom("tags").select(["id", "name"]).where("name", "in", unique).execute()
  const ids = new Map(rows.map((row) => [row.name, row.id]))
  await db
    .insertInto("link_tags")
    .values(unique.map((name) => ({ link_id: linkId, tag_id: ids.get(name)! })))
    .execute()
}

/** A link carries any of `names`. A subquery, not a join, so the list's count query stays join-free. */
function hasAnyTag(names: string[]) {
  return sql<SqlBool>`exists (
    select 1 from link_tags join tags on tags.id = link_tags.tag_id
    where link_tags.link_id = links.id and tags.name = any(${sql.val(names)}::text[])
  )`
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

export async function listLinks({ db }: Deps, q: LinkListQuery): Promise<Page<Link>> {
  const { query, total } = linkQuery(db)

  let filtered = query
  if (q.status !== "all") filtered = filtered.where("links.status", "=", q.status)
  if (q.domain_id.length) filtered = filtered.where("links.domain_id", "in", q.domain_id)
  if (q.tags.length) filtered = filtered.where(hasAnyTag(q.tags))
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

  let countQuery = db.selectFrom("links").select((eb) => eb.fn.countAll<number>().as("total"))
  if (q.status !== "all") countQuery = countQuery.where("status", "=", q.status)
  if (q.domain_id.length) countQuery = countQuery.where("domain_id", "in", q.domain_id)
  if (q.tags.length) countQuery = countQuery.where(hasAnyTag(q.tags))
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

  return { data: rows.map(toLink), total: matched, limit: q.limit, offset: q.offset }
}

/** Just the count — no rows, no joins. */
export async function countLinks({ db }: Deps, q: LinkCountQuery): Promise<LinkCount> {
  let countQuery = db.selectFrom("links").select((eb) => eb.fn.countAll<number>().as("total"))
  if (q.status !== "all") countQuery = countQuery.where("status", "=", q.status)
  const { total = 0 } = (await countQuery.executeTakeFirst()) ?? {}
  return { total }
}

export async function createLink(
  { db, config, cache, metadata }: Deps,
  principal: Principal,
  body: LinkCreate,
): Promise<Link> {
  assertCan(principal, "create", "Link")
  if (body.slug && isReservedSlug(body.slug, config.LINQ_CLIENT_BASE_PATH)) {
    throw ApiError.validation("request validation failed", [
      { code: "custom", path: ["slug"], message: "slug is reserved" },
    ])
  }
  const fetched = await metadata.fetch(body.destination)

  // FOR SHARE conflicts with the archiver's FOR UPDATE (domains/service.ts's
  // archive transactions) but not with itself, so concurrent creates on
  // one domain still run in parallel and only an in-flight archive blocks
  // them. Without this lock, a plain transaction would not close the race
  // under READ COMMITTED.
  const row = await db.transaction().execute(async (tx) => {
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
        forward_query: body.forward_query,
        preset_params: body.preset_params,
        expires_at: body.expires_at ? new Date(body.expires_at) : null,
        listed: body.listed,
      },
      {
        slug: body.slug,
        slugLength: config.LINQ_SLUG_LENGTH,
        clientBasePath: config.LINQ_CLIENT_BASE_PATH,
      },
    )

    await setLinkTags(tx, linkRow.id, body.tags)

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
  await cache.del(...linkKeys(row.domain_id, row.slug))
  return fetchLink(db, row.id)
}

export function getLink({ db }: Deps, id: string): Promise<Link> {
  return fetchLink(db, id)
}

export async function updateLink(
  { db, cache, metadata }: Deps,
  principal: Principal,
  id: string,
  patch: LinkPatch,
): Promise<Link> {
  const existing = await loadLink(db, id)
  // Archiving or restoring (a status change) is admin-only; every other
  // field is an ordinary edit. See resources/docs/adr/0016.
  if (patch.status !== undefined) {
    assertCanArchive(principal)
  } else {
    assertCanEdit(principal)
  }

  const fetched = patch.destination !== undefined ? await metadata.fetch(patch.destination) : null

  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable("links")
      .set({
        // Spelled out rather than a blanket `...patch` spread: `expires_at`
        // arrives as an ISO string and the column takes a Date, so the spread
        // would not typecheck. See keys/service.ts's update for the same pattern.
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

    if (patch.tags !== undefined) await setLinkTags(tx, id, patch.tags)

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
  await cache.del(...linkKeys(existing.domain_id, existing.slug))
  return fetchLink(db, id)
}

/**
 * Bulk analogue of `purgeLink` — "Empty archive" destroys every archived
 * link in one call instead of the client purging one row at a time.
 *
 * No filters beyond `status = archived`: purging is only ever "every
 * archived link", the same invariant `purgeLink` already enforces one row
 * at a time, so there is nothing else for a caller to scope this to.
 */
export async function purgeArchivedLinks({ db, cache }: Deps, principal: Principal): Promise<LinkPurgeResult> {
  assertCanPurge(principal)

  const rows = await span(
    "link.purgeAll",
    () =>
      db
        .deleteFrom("links")
        .where("status", "=", "archived")
        .returning(["domain_id", "slug"])
        .execute(),
    { out: (deleted) => ({ purged: deleted.length }) },
  )

  await cache.del(...rows.flatMap((r) => linkKeys(r.domain_id, r.slug)))
  return { purged: rows.length }
}

/** An alias for archiving; links are never dropped. See resources/docs/adr/0002.
 *  Admin only, same as restoring one — see resources/docs/adr/0016. */
export async function archiveLink({ db, cache }: Deps, principal: Principal, id: string): Promise<Link> {
  const existing = await loadLink(db, id)
  assertCanArchive(principal)

  await db
    .updateTable("links")
    .set({ status: "archived", updated_at: new Date() })
    .where("id", "=", id)
    .execute()
  await cache.del(...linkKeys(existing.domain_id, existing.slug))
  return fetchLink(db, id)
}

/**
 * Destroys an archived link for good. Admin only, and archived-first, so a live
 * short URL can never be destroyed by one call. Rules and visits go with it —
 * `visits.link_id` is `ON DELETE CASCADE`, so a link's own traffic is
 * destroyed, not reclassified as orphan traffic.
 *
 * Unlike archiving, this **releases the slug** for reuse on that domain. See
 * resources/docs/adr/0002.
 */
export async function purgeLink({ db, cache }: Deps, principal: Principal, id: string): Promise<void> {
  assertCanPurge(principal)
  const existing = await loadLink(db, id)
  if (existing.status !== "archived") {
    throw ApiError.conflict("archive the link before purging it")
  }

  await span("link.purge", async () => db.deleteFrom("links").where("id", "=", id).execute(), {
    in: { link_id: id, slug: existing.slug },
  })
  await cache.del(...linkKeys(existing.domain_id, existing.slug))
}

/**
 * Tags in use on active links, most used first. Counted per request rather
 * than stored, so there is no counter to keep in step with archive, restore
 * and purge; a tag no link carries any more is simply absent. See resources/docs/adr/0020.
 */
export function listTags({ db }: Deps): Promise<{ tag: string; count: number }[]> {
  return db
    .selectFrom("link_tags")
    .innerJoin("tags", "tags.id", "link_tags.tag_id")
    .innerJoin("links", "links.id", "link_tags.link_id")
    .where("links.status", "=", "active")
    .select(["tags.name as tag", (eb) => eb.fn.countAll<number>().as("count")])
    .groupBy("tags.name")
    .orderBy("count", "desc")
    .orderBy("tags.name")
    .execute()
}
