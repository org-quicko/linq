import type {
  Cache,
  Link,
  LinkCreateInput,
  LinkListQuery,
  LinkPatch,
  LinkRow,
  MetadataFetcher,
  ResourceStatus,
  Rule,
  RuleInput,
} from "@linq/shared"
import { sql } from "kysely"
import type { Db } from "../clients/index.ts"
import type { Config } from "../config.ts"
import {
  LinkCreateInputToLinkInsertConverter,
  LinkJoinedRowToLinkConverter,
  LinkPatchToLinkUpdateConverter,
  RuleRowToRuleConverter,
} from "../converters/index.ts"
import { HttpError, Log } from "../libs/index.ts"
import { CacheKeyUtil, FilterUtil, SlugUtil } from "../utils/index.ts"
import { RuleService } from "./RuleService.ts"

const linkCreateInputToLinkInsertConverter = new LinkCreateInputToLinkInsertConverter()
const linkJoinedRowToLinkConverter = new LinkJoinedRowToLinkConverter()
const linkPatchToLinkUpdateConverter = new LinkPatchToLinkUpdateConverter()
const ruleRowToRuleConverter = new RuleRowToRuleConverter()

/**
 * Links, their tags and their rules. Owns every link query and business rule
 * (reserved slugs, slug allocation, destination metadata, archive-before-purge)
 * and clears a link's cache entries on every write, so no caller can forget to.
 */
export class LinkService {
  /**
   * @param db - The database.
   * @param cache - Cleared on every write; the redirect and llms.txt read through it.
   * @param metadata - Fetches a destination's title, description and icon.
   * @param config - Slug length, and the Client UI's base path, whose first segment is reserved.
   */
  constructor(
    private readonly db: Db,
    private readonly cache: Cache,
    private readonly metadata: MetadataFetcher,
    private readonly config: Pick<Config, "LINQ_SLUG_LENGTH" | "LINQ_CLIENT_BASE_PATH">,
  ) {}

  /**
   * Loads one link as a complete API response, joins and visit totals included.
   *
   * @param id - id of the link.
   * @returns The link.
   * @throws {HttpError} 404 if no link matches the id.
   */
  @Log("link.fetch", {
    in: (id: string) => ({ link_id: id }),
    out: (link: Link) => ({ slug: link.slug, status: link.status }),
  })
  async get(id: string): Promise<Link> {
    const row = await this.linkQuery().where("links.id", "=", id).limit(1).executeTakeFirst()
    if (!row) throw HttpError.notFound("link")
    return linkJoinedRowToLinkConverter.convertFrom(row)
  }

  /**
   * Loads the raw row, for permission checks that run before the response is built.
   *
   * @param id - id of the link.
   * @returns The link row.
   * @throws {HttpError} 404 if no link matches the id.
   */
  @Log("link.load", {
    in: (id: string) => ({ link_id: id }),
    out: (link: LinkRow) => ({ status: link.status }),
  })
  async load(id: string): Promise<LinkRow> {
    const row = await this.db
      .selectFrom("links")
      .selectAll()
      .where("id", "=", id)
      .limit(1)
      .executeTakeFirst()
    if (!row) throw HttpError.notFound("link")
    return row
  }

  /**
   * Lists one filtered, sorted page of links.
   *
   * @param q - Filters, sort and page.
   * @returns The page, and the total the filters match.
   */
  async list(q: LinkListQuery): Promise<{ data: Link[]; total: number }> {
    const filters = FilterUtil.linkFilters(q)
    // Every sortable column in one place; `visits` is the joined expression
    // rather than a column, which is why this is a map and not a field name.
    const sortable = {
      created_at: sql`links.created_at`,
      updated_at: sql`links.updated_at`,
      visits: sql`coalesce(visit_counts.human, 0) + coalesce(visit_counts.bot, 0)`,
    }
    const rows = await this.linkQuery()
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
      (await this.db
        .selectFrom("links")
        .select((eb) => eb.fn.countAll<number>().as("total"))
        .where((eb) => eb.and(filters))
        .executeTakeFirst()) ?? {}

    return { data: rows.map(linkJoinedRowToLinkConverter.convertFrom), total }
  }

  /**
   * Counts links — no rows, no joins.
   *
   * @param status - Which links to count.
   * @returns The count.
   */
  async count(status: ResourceStatus | "all"): Promise<number> {
    let query = this.db.selectFrom("links").select((eb) => eb.fn.countAll<number>().as("total"))
    if (status !== "all") query = query.where("status", "=", status)
    const { total = 0 } = (await query.executeTakeFirst()) ?? {}
    return total
  }

  /**
   * Creates a link with its tags and rules in one transaction, after fetching
   * its destination's metadata.
   *
   * Slug races are settled by the database: `onConflict doNothing` returns no
   * row when the slug was taken, so two concurrent creates can never both
   * claim one slug. Archived links keep their slug, so a retry never
   * resurrects a dead link.
   *
   * @param input - The validated create body.
   * @returns The created link.
   * @throws {HttpError} 400 if the requested slug is reserved.
   * @throws {HttpError} 404 if the domain does not exist.
   * @throws {HttpError} 409 if the domain is archived, the slug is taken, or no free slug was found.
   */
  async create(input: LinkCreateInput): Promise<Link> {
    const { LINQ_SLUG_LENGTH: slugLength, LINQ_CLIENT_BASE_PATH: clientBasePath } = this.config
    if (input.slug && SlugUtil.isReservedSlug(input.slug, clientBasePath)) {
      throw HttpError.validation("request validation failed", [
        { code: "custom", path: ["slug"], message: "slug is reserved" },
      ])
    }
    const fetched = await this.metadata.fetch(input.destination)

    // FOR SHARE conflicts with the archiver's FOR UPDATE (DomainService's
    // archive transactions) but not with itself, so concurrent creates on one
    // domain still run in parallel and only an in-flight archive blocks them.
    // Without this lock, a plain transaction would not close the race under
    // READ COMMITTED.
    const created = await this.db.transaction().execute(async (tx) => {
      const domain = await tx
        .selectFrom("domains")
        .select("status")
        .where("id", "=", input.domain_id)
        .forShare()
        .limit(1)
        .executeTakeFirst()
      if (!domain) throw HttpError.notFound("domain")
      if (domain.status === "archived") throw HttpError.conflict("domain is archived")

      const { row } = await LinkService.insertLink(tx, input, fetched, slugLength, clientBasePath)

      await LinkService.setLinkTags(tx, row.id, input.tags)
      if (input.rules.length > 0) await new RuleService(tx).replace(row.id, input.rules)
      return row
    })

    // Clears the negative entry left behind while this slug was 404ing.
    await this.cache.del(...CacheKeyUtil.linkKeys(created.domain_id, created.slug))
    return this.get(created.id)
  }

  /**
   * Applies a patch, its tags and its rules in one transaction, re-fetching
   * metadata only when the destination changes.
   *
   * @param existing - The link, as loaded for the permission check.
   * @param patch - The validated patch body.
   * @returns The updated link.
   */
  async update(existing: LinkRow, patch: LinkPatch): Promise<Link> {
    const fetched =
      patch.destination !== undefined ? await this.metadata.fetch(patch.destination) : null
    await this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("links")
        .set(linkPatchToLinkUpdateConverter.convertFrom(existing, patch, fetched))
        .where("id", "=", existing.id)
        .execute()

      if (patch.tags !== undefined) await LinkService.setLinkTags(tx, existing.id, patch.tags)
      if (patch.rules !== undefined) await new RuleService(tx).replace(existing.id, patch.rules)
    })
    await this.cache.del(...CacheKeyUtil.linkKeys(existing.domain_id, existing.slug))
    return this.get(existing.id)
  }

  /**
   * Archives a link. The row and its slug are kept; links are never dropped by
   * DELETE. See resources/docs/adr/0002.
   *
   * @param existing - The link, as loaded for the permission check.
   * @returns The archived link.
   */
  async archive(existing: LinkRow): Promise<Link> {
    await this.db
      .updateTable("links")
      .set({ status: "archived", updated_at: new Date() })
      .where("id", "=", existing.id)
      .execute()
    await this.cache.del(...CacheKeyUtil.linkKeys(existing.domain_id, existing.slug))
    return this.get(existing.id)
  }

  /**
   * Destroys an archived link for good, releasing its slug. Rules and visits
   * go with it — `visits.link_id` is `ON DELETE CASCADE`. See resources/docs/adr/0002.
   *
   * @param link - The link, as loaded for the permission check.
   * @throws {HttpError} 409 if the link is not archived.
   */
  async purge(link: LinkRow): Promise<void> {
    if (link.status !== "archived") throw HttpError.conflict("archive the link before purging it")
    await this.deleteLink(link)
    await this.cache.del(...CacheKeyUtil.linkKeys(link.domain_id, link.slug))
  }

  /**
   * Destroys every archived link.
   *
   * @returns How many links were destroyed.
   */
  async purgeArchived(): Promise<number> {
    const rows = await this.deleteArchived()
    await this.cache.del(...rows.flatMap((row) => CacheKeyUtil.linkKeys(row.domain_id, row.slug)))
    return rows.length
  }

  /**
   * Lists the tags in use on active links, most used first. Counted per
   * request rather than stored, so there is no counter to keep in step with
   * archive, restore and purge; a tag no link carries any more is simply
   * absent. See resources/docs/adr/0020.
   *
   * @returns Each tag, with how many active links carry it.
   */
  listTags(): Promise<{ tag: string; count: number }[]> {
    return this.db
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

  /**
   * Lists a link's rules, in `position` order.
   *
   * @param id - id of the link.
   * @returns The rules.
   * @throws {HttpError} 404 if no link matches the id, rather than an empty list.
   */
  async listRules(id: string): Promise<Rule[]> {
    await this.load(id)
    return (await new RuleService(this.db).list(id)).map(ruleRowToRuleConverter.convertFrom)
  }

  /**
   * Replaces a link's whole ordered rule set in one transaction; the server owns `position`.
   *
   * @param link - The link, as loaded for the permission check.
   * @param rules - The new rule set, in order.
   * @returns The rules as stored.
   */
  async replaceRules(link: LinkRow, rules: RuleInput[]): Promise<Rule[]> {
    await this.db.transaction().execute((tx) => new RuleService(tx).replace(link.id, rules))
    // The redirect caches a link's rules inside its target entry, so replacing
    // them clears it just as editing the link itself does.
    await this.cache.del(CacheKeyUtil.targetKey(link.domain_id, link.slug))
    return (await new RuleService(this.db).list(link.id)).map(ruleRowToRuleConverter.convertFrom)
  }

  /**
   * Every link response carries its visit totals, so the joins live in one place.
   *
   * The totals come off `visit_counts`, which a trigger keeps in step with the
   * visits table: one indexed row per link rather than an unbounded aggregate run
   * on every page of the list. See resources/docs/adr/0007.
   *
   * @returns The joined select, ready for a `where`.
   */
  private linkQuery() {
    return this.db
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

  /**
   * Replaces a link's tags, dropping duplicates. The ids are re-read rather than
   * taken from `returning`: `doNothing` returns no row for a tag that already
   * exists. A concurrent insert of the same new tag blocks on the unique
   * constraint until the other transaction settles, and the select that follows
   * is a new statement, so it sees that commit.
   *
   * @param db - The transaction the tag writes join.
   * @param linkId - id of the link.
   * @param names - The link's new tags; duplicates are dropped.
   */
  private static async setLinkTags(db: Db, linkId: string, names: string[]): Promise<void> {
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

  @Log("link.insert", {
    in: (_tx: Db, input: LinkCreateInput) => ({
      domain_id: input.domain_id,
      slug: input.slug ?? null,
    }),
    out: ({ row, attempts }: { row: LinkRow; attempts: number }) => ({
      link_id: row.id,
      slug: row.slug,
      attempts,
    }),
  })
  private static async insertLink(
    tx: Db,
    input: LinkCreateInput,
    fetched: Awaited<ReturnType<MetadataFetcher["fetch"]>>,
    slugLength: number,
    clientBasePath: string,
  ) {
    const attempts = input.slug ? 1 : 5
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const slug = input.slug ?? SlugUtil.generateSlug(slugLength)
      if (SlugUtil.isReservedSlug(slug, clientBasePath)) continue
      const inserted = await tx
        .insertInto("links")
        .values({
          id: Bun.randomUUIDv7(),
          ...linkCreateInputToLinkInsertConverter.convertFrom(input, fetched, slug),
        })
        .onConflict((oc) => oc.columns(["domain_id", "slug"]).doNothing())
        .returningAll()
        .executeTakeFirst()
      // The attempt count is the signal that LINQ_SLUG_LENGTH is running out.
      if (inserted) return { row: inserted, attempts: attempt }
    }
    if (input.slug) throw HttpError.conflict(`slug "${input.slug}" is taken on this domain`)
    throw HttpError.conflict("could not allocate a free slug; raise LINQ_SLUG_LENGTH")
  }

  @Log("link.purge", { in: (link: LinkRow) => ({ link_id: link.id, slug: link.slug }) })
  private async deleteLink(link: LinkRow) {
    return this.db.deleteFrom("links").where("id", "=", link.id).execute()
  }

  @Log("link.purgeAll", {
    out: (deleted: { domain_id: string; slug: string }[]) => ({ purged: deleted.length }),
  })
  private async deleteArchived() {
    return this.db
      .deleteFrom("links")
      .where("status", "=", "archived")
      .returning(["domain_id", "slug"])
      .execute()
  }
}
