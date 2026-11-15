import { randomInt } from "node:crypto"
import {
  ApiError,
  destinationTitle,
  type Link,
  type LinkPatch,
  type linkCreateSchema,
  type linkListQuerySchema,
} from "@linq/shared"
import { type RawBuilder, type Selectable, type SqlBool, sql } from "kysely"
import type { z } from "zod"
import { isReservedSlug } from "../config.ts"
import type { DB } from "../db/types.generated.ts"
import { type Db, type Metadata, span } from "../libs/index.ts"
import { replaceRules } from "./RuleService.ts"

type LinkCreateInput = z.infer<typeof linkCreateSchema>
type LinkListQuery = z.infer<typeof linkListQuerySchema>
type LinkRow = Selectable<DB["links"]>

/** base62. Reserved slugs and the accepted shape live in @linq/shared. */
const SLUG_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/** A port only ever appears in a local setup, where no TLS terminator is in front. */
export function shortUrl(host: string, slug: string): string {
  const scheme = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? "http" : "https"
  return `${scheme}://${host}/${slug}`
}

/**
 * Every link response carries its visit totals, so the joins live in one place.
 *
 * The totals come off `visit_counts`, which a trigger keeps in step with the
 * visits table: one indexed row per link rather than an unbounded aggregate run
 * on every page of the list. See resources/docs/adr/0007.
 */
function linkQuery(db: Db) {
  return db
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
}

/** Maps a joined link row to the JSON shape the API returns. */
function toLink(
  row: LinkRow & {
    domain_host: string
    human_visits: number
    bot_visits: number
    rule_count: number
    tags: string[]
  },
): Link {
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
 * The list's filters, as predicates over `links` columns only, so the page
 * query (which joins) and the count query (which does not) share them. Expiry
 * uses the app clock, so the list agrees with the redirect on what "expired"
 * means.
 */
function linkFilters(q: LinkListQuery): RawBuilder<SqlBool>[] {
  const filters: RawBuilder<SqlBool>[] = []
  if (q.status !== "all") filters.push(sql<SqlBool>`links.status = ${q.status}`)
  if (q.domain_id.length) filters.push(sql<SqlBool>`links.domain_id in (${sql.join(q.domain_id)})`)
  if (q.tags.length) {
    // A subquery, not a join, so the count query stays join-free.
    filters.push(sql<SqlBool>`exists (
      select 1 from link_tags join tags on tags.id = link_tags.tag_id
      where link_tags.link_id = links.id and tags.name = any(${sql.val(q.tags)}::text[])
    )`)
  }
  if (q.search) {
    const term = `%${q.search}%`
    filters.push(
      sql<SqlBool>`(links.slug ilike ${term} or links.name ilike ${term} or links.destination ilike ${term})`,
    )
  }
  if (q.expiry !== "any") {
    const now = new Date()
    filters.push(
      q.expiry === "expired"
        ? sql<SqlBool>`(links.expires_at is not null and links.expires_at <= ${now})`
        : sql<SqlBool>`(links.expires_at is null or links.expires_at > ${now})`,
    )
  }
  return filters
}

/**
 * Replaces a link's tags, dropping duplicates. The ids are re-read rather than
 * taken from `returning`: `doNothing` returns no row for a tag that already
 * exists. A concurrent insert of the same new tag blocks on the unique
 * constraint until the other transaction settles, and the select that follows
 * is a new statement, so it sees that commit.
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
  const rows = await db
    .selectFrom("tags")
    .select(["id", "name"])
    .where("name", "in", unique)
    .execute()
  const ids = new Map(rows.map((row) => [row.name, row.id]))
  await db
    .insertInto("link_tags")
    .values(unique.map((name) => ({ link_id: linkId, tag_id: ids.get(name)! })))
    .execute()
}

/** Loads one link as a complete API response, joins and visit totals included, or throws 404. */
export function getLink(db: Db, id: string): Promise<Link> {
  return span(
    "link.fetch",
    async () => {
      const row = await linkQuery(db).where("links.id", "=", id).limit(1).executeTakeFirst()
      if (!row) throw ApiError.notFound("link")
      return toLink(row)
    },
    { in: { link_id: id }, out: (link) => ({ slug: link.slug, status: link.status }) },
  )
}

/** The raw row, for permission checks that run before the response is built. Throws 404. */
export function loadLink(db: Db, id: string): Promise<LinkRow> {
  return span(
    "link.load",
    async () => {
      const row = await db
        .selectFrom("links")
        .selectAll()
        .where("id", "=", id)
        .limit(1)
        .executeTakeFirst()
      if (!row) throw ApiError.notFound("link")
      return row
    },
    { in: { link_id: id }, out: (link) => ({ status: link.status }) },
  )
}

export async function listLinks(db: Db, q: LinkListQuery) {
  const filters = linkFilters(q)
  // Every sortable column in one place; `visits` is the joined expression
  // rather than a column, which is why this is a map and not a field name.
  const sortable = {
    created_at: sql`links.created_at`,
    updated_at: sql`links.updated_at`,
    visits: sql`coalesce(visit_counts.human, 0) + coalesce(visit_counts.bot, 0)`,
  }
  const rows = await linkQuery(db)
    .where((eb) => eb.and(filters))
    // `links.id` is a UUIDv7, so the tiebreak is chronological rather than
    // arbitrary — and without it equal sort keys make paging
    // non-deterministic: a row can appear on two pages or on none.
    .orderBy(sortable[q.sort], q.order)
    .orderBy("links.id", q.order)
    .limit(q.limit)
    .offset(q.offset)
    .execute()

  const { total = 0 } =
    (await db
      .selectFrom("links")
      .select((eb) => eb.fn.countAll<number>().as("total"))
      .where((eb) => eb.and(filters))
      .executeTakeFirst()) ?? {}

  return { data: rows.map(toLink), total }
}

/** Just the count — no rows, no joins. */
export async function countLinks(db: Db, status: "active" | "archived" | "all"): Promise<number> {
  let query = db.selectFrom("links").select((eb) => eb.fn.countAll<number>().as("total"))
  if (status !== "all") query = query.where("status", "=", status)
  const { total = 0 } = (await query.executeTakeFirst()) ?? {}
  return total
}

/**
 * Creates a link with its tags and rules in one transaction. Returns the raw row.
 *
 * Slug races are settled by the database: `onConflict doNothing` returns no row
 * when the slug was taken, so two concurrent creates can never both claim one
 * slug. Archived links keep their slug, so a retry never resurrects a dead link.
 */
export function createLink(
  db: Db,
  input: LinkCreateInput,
  fetched: Metadata,
  options: { slugLength: number; clientBasePath: string },
): Promise<LinkRow> {
  // FOR SHARE conflicts with the archiver's FOR UPDATE (DomainService's
  // archive transactions) but not with itself, so concurrent creates on one
  // domain still run in parallel and only an in-flight archive blocks them.
  // Without this lock, a plain transaction would not close the race under
  // READ COMMITTED.
  return db.transaction().execute(async (tx) => {
    const domain = await tx
      .selectFrom("domains")
      .select("status")
      .where("id", "=", input.domain_id)
      .forShare()
      .limit(1)
      .executeTakeFirst()
    if (!domain) throw ApiError.notFound("domain")
    if (domain.status === "archived") throw ApiError.conflict("domain is archived")

    const { row } = await span(
      "link.insert",
      async () => {
        const attempts = input.slug ? 1 : 5
        for (let attempt = 1; attempt <= attempts; attempt++) {
          const slug =
            input.slug ??
            Array.from(
              { length: options.slugLength },
              // Uniform: `randomInt` rejects biased samples, which a plain
              // `randomBytes` modulo would not.
              () => SLUG_ALPHABET[randomInt(SLUG_ALPHABET.length)],
            ).join("")
          if (isReservedSlug(slug, options.clientBasePath)) continue
          const inserted = await tx
            .insertInto("links")
            .values({
              id: Bun.randomUUIDv7(),
              slug,
              domain_id: input.domain_id,
              destination: input.destination,
              // A link should always have a useful label even when metadata
              // fetching is disabled (the secure default) or the page has no
              // title. A caller-supplied name remains authoritative.
              name: input.name ?? fetched.name ?? destinationTitle(input.destination),
              description: input.description ?? fetched.description ?? null,
              icon_url: fetched.icon_url,
              forward_query: input.forward_query,
              preset_params: input.preset_params,
              expires_at: input.expires_at ? new Date(input.expires_at) : null,
              listed: input.listed,
            })
            .onConflict((oc) => oc.columns(["domain_id", "slug"]).doNothing())
            .returningAll()
            .executeTakeFirst()
          // The attempt count is the signal that LINQ_SLUG_LENGTH is running out.
          if (inserted) return { row: inserted, attempts: attempt }
        }
        if (input.slug) throw ApiError.conflict(`slug "${input.slug}" is taken on this domain`)
        throw ApiError.conflict("could not allocate a free slug; raise LINQ_SLUG_LENGTH")
      },
      {
        in: { domain_id: input.domain_id, slug: input.slug ?? null },
        out: ({ row, attempts }) => ({ link_id: row.id, slug: row.slug, attempts }),
      },
    )

    await setLinkTags(tx, row.id, input.tags)
    if (input.rules.length > 0) await replaceRules(tx, row.id, input.rules)
    return row
  })
}

/**
 * Applies a patch in one transaction. `fetched` is the new destination's
 * metadata, or null when the destination is unchanged; it fills only the
 * fields the patch itself leaves alone.
 */
export async function updateLink(
  db: Db,
  existing: LinkRow,
  patch: LinkPatch,
  fetched: Metadata | null,
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable("links")
      .set({
        // Spelled out rather than a blanket `...patch` spread: `expires_at`
        // arrives as an ISO string and the column takes a Date, so the spread
        // would not typecheck.
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
      .where("id", "=", existing.id)
      .execute()

    if (patch.tags !== undefined) await setLinkTags(tx, existing.id, patch.tags)
    if (patch.rules !== undefined) await replaceRules(tx, existing.id, patch.rules)
  })
}

/** Archiving keeps the row and its slug; links are never dropped by DELETE. See resources/docs/adr/0002. */
export async function archiveLink(db: Db, id: string): Promise<void> {
  await db
    .updateTable("links")
    .set({ status: "archived", updated_at: new Date() })
    .where("id", "=", id)
    .execute()
}

/**
 * Destroys an archived link for good, releasing its slug. Rules and visits go
 * with it — `visits.link_id` is `ON DELETE CASCADE`. See resources/docs/adr/0002.
 */
export async function purgeLink(db: Db, link: LinkRow): Promise<void> {
  if (link.status !== "archived") throw ApiError.conflict("archive the link before purging it")
  await span("link.purge", async () => db.deleteFrom("links").where("id", "=", link.id).execute(), {
    in: { link_id: link.id, slug: link.slug },
  })
}

/** Destroys every archived link. Returns what was removed, for cache invalidation. */
export function purgeArchivedLinks(db: Db) {
  return span(
    "link.purgeAll",
    () =>
      db
        .deleteFrom("links")
        .where("status", "=", "archived")
        .returning(["domain_id", "slug"])
        .execute(),
    { out: (deleted) => ({ purged: deleted.length }) },
  )
}

/**
 * Tags in use on active links, most used first. Counted per request rather
 * than stored, so there is no counter to keep in step with archive, restore
 * and purge; a tag no link carries any more is simply absent. See resources/docs/adr/0020.
 */
export function listTags(db: Db) {
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
