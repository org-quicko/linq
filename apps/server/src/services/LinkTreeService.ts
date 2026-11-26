import type {
  Cache,
  LinkRow,
  LinkTree,
  LinkTreeCreateInput,
  LinkTreeItemInput,
  LinkTreeItemJoinedRow,
  LinkTreePatch,
  LinkTreeRow,
} from "@linq/shared"
import {
  LinkTreeCreateInputToLinkInsertConverter,
  LinkTreeRowsToLinkTreeConverter,
} from "../converters/index.ts"
import type { Db } from "../db/index.ts"
import { HttpError, Log } from "../libs/index.ts"
import { CacheKeyUtil } from "../utils/index.ts"
import { LinkService, type PreparedLink } from "./LinkService.ts"

/** One Item, ready to write: an existing Link, or a short Link still to create. */
type PreparedItem =
  | { label: string; link_id: string }
  | { label: string | undefined; prepared: PreparedLink }

/**
 * Link Trees: a Link of type `tree`, its page settings and its ordered Items.
 * Archiving, restoring and purging a tree are ordinary Link operations and stay
 * on `LinkService`; this service owns creating and editing the page.
 *
 * Every Item targets an active redirect Link on the tree's own Domain. An Item
 * given as a URL becomes a new short Link there, in the same transaction as the
 * tree, so a failed save never leaves stray Links behind.
 */
export class LinkTreeService {
  private readonly linkTreeCreateInputToLinkInsertConverter: LinkTreeCreateInputToLinkInsertConverter
  private readonly linkTreeRowsToLinkTreeConverter: LinkTreeRowsToLinkTreeConverter

  /**
   * @param db - The database.
   * @param cache - Cleared on every write; the redirect reads a tree's page through it.
   * @param linkService - Slug allocation, tags, and the short Links URL Items become.
   */
  constructor(
    private readonly db: Db,
    private readonly cache: Cache,
    private readonly linkService: LinkService,
  ) {
    this.linkTreeCreateInputToLinkInsertConverter = new LinkTreeCreateInputToLinkInsertConverter()
    this.linkTreeRowsToLinkTreeConverter = new LinkTreeRowsToLinkTreeConverter()
  }

  /**
   * Loads one Link Tree as a complete API response, Items included.
   *
   * @param id - id of the tree's Link.
   * @returns The Link Tree.
   * @throws {HttpError} 404 if no Link Tree matches the id.
   */
  @Log("linkTree.fetch", { in: (id: string) => ({ link_id: id }) })
  async get(id: string): Promise<LinkTree> {
    const link = await this.linkService.get(id)
    if (link.type !== "tree") throw HttpError.notFound("link tree")
    const tree = await this.db
      .selectFrom("link_trees")
      .selectAll()
      .where("link_id", "=", id)
      .executeTakeFirstOrThrow()
    const items = await LinkTreeService.itemQuery(this.db, id).execute()
    return this.linkTreeRowsToLinkTreeConverter.convertFrom(link, tree, items)
  }

  /**
   * Loads the raw row, for permission checks that run before the response is built.
   *
   * @param id - id of the tree's Link.
   * @returns The `links` row.
   * @throws {HttpError} 404 if no Link Tree matches the id.
   */
  async load(id: string): Promise<LinkRow> {
    const row = await this.linkService.load(id)
    if (row.type !== "tree") throw HttpError.notFound("link tree")
    return row
  }

  /**
   * What a tree's public page is built from: its settings and the Items whose
   * Link is still active. Expiry is left to the redirect, since an Item can
   * lapse while its page is cached. Static, because `RedirectService` reads it
   * on the hot path without depending on this service.
   *
   * @param db - The database to read from.
   * @param treeId - id of the tree's Link.
   * @returns The `link_trees` row and the active Items, in order.
   */
  static async pageRows(
    db: Db,
    treeId: string,
  ): Promise<{ tree: LinkTreeRow; items: LinkTreeItemJoinedRow[] }> {
    const tree = await db
      .selectFrom("link_trees")
      .selectAll()
      .where("link_id", "=", treeId)
      .executeTakeFirstOrThrow()
    const items = await LinkTreeService.itemQuery(db, treeId)
      .where("links.status", "=", "active")
      .execute()
    return { tree, items }
  }

  /**
   * Creates a Link Tree, its page settings, tags and Items in one transaction.
   *
   * @param input - The validated create body.
   * @returns The created Link Tree.
   * @throws {HttpError} 400 if the slug is reserved or an Item's Link is not usable.
   * @throws {HttpError} 404 if the domain does not exist.
   * @throws {HttpError} 409 if the domain is archived, the slug is taken, or no free slug was found.
   */
  async create(input: LinkTreeCreateInput): Promise<LinkTree> {
    this.linkService.assertSlugAllowed(input.slug)
    const items = await this.prepareItems(input.domain_id, input.items)

    const { tree, created } = await this.db.transaction().execute(async (tx) => {
      const row = await this.linkService.insertRow(tx, input.domain_id, input.slug, (slug) =>
        this.linkTreeCreateInputToLinkInsertConverter.convertFrom(input, slug),
      )
      await tx
        .insertInto("link_trees")
        .values({
          link_id: row.id,
          image_url: input.image_url ?? null,
          appearance: input.appearance,
          accent: input.accent,
          button_style: input.button_style,
        })
        .execute()
      await LinkService.setTags(tx, row.id, input.tags)
      return { tree: row, created: await this.writeItems(tx, row.id, items) }
    })

    await this.cache.del(
      ...CacheKeyUtil.linkKeys(tree.domain_id, tree.slug),
      ...created.flatMap((link) => CacheKeyUtil.linkKeys(link.domain_id, link.slug)),
    )
    return this.get(tree.id)
  }

  /**
   * Applies a patch to a Link Tree in one transaction. `items`, when sent,
   * replaces the whole ordered list.
   *
   * @param existing - The tree's `links` row, as loaded for the permission check.
   * @param patch - The validated patch body.
   * @returns The updated Link Tree.
   * @throws {HttpError} 400 if an Item's Link is not usable.
   */
  async update(existing: LinkRow, patch: LinkTreePatch): Promise<LinkTree> {
    const items = patch.items ? await this.prepareItems(existing.domain_id, patch.items) : null

    const created = await this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("links")
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          updated_at: new Date(),
        })
        .where("id", "=", existing.id)
        .execute()

      const style = {
        ...(patch.image_url !== undefined ? { image_url: patch.image_url } : {}),
        ...(patch.appearance !== undefined ? { appearance: patch.appearance } : {}),
        ...(patch.accent !== undefined ? { accent: patch.accent } : {}),
        ...(patch.button_style !== undefined ? { button_style: patch.button_style } : {}),
      }
      if (Object.keys(style).length > 0)
        await tx.updateTable("link_trees").set(style).where("link_id", "=", existing.id).execute()

      if (patch.tags !== undefined) await LinkService.setTags(tx, existing.id, patch.tags)
      if (!items) return []
      await tx.deleteFrom("link_tree_items").where("tree_id", "=", existing.id).execute()
      return this.writeItems(tx, existing.id, items)
    })

    await this.cache.del(
      ...CacheKeyUtil.linkKeys(existing.domain_id, existing.slug),
      ...created.flatMap((link) => CacheKeyUtil.linkKeys(link.domain_id, link.slug)),
    )
    return this.get(existing.id)
  }

  /**
   * The Items joined to their target Links and Domain, in `position` order.
   *
   * @param db - The database or transaction to read from.
   * @param treeId - id of the tree's Link.
   * @returns The select, ready for a further `where`.
   */
  private static itemQuery(db: Db, treeId: string) {
    return db
      .selectFrom("link_tree_items")
      .innerJoin("links", "links.id", "link_tree_items.link_id")
      .innerJoin("domains", "domains.id", "links.domain_id")
      .select([
        "link_tree_items.id",
        "link_tree_items.label",
        "link_tree_items.link_id",
        "links.slug",
        "links.name",
        "links.destination",
        "links.status",
        "links.expires_at",
        "domains.host as domain_host",
      ])
      .where("link_tree_items.tree_id", "=", treeId)
      .orderBy("link_tree_items.position")
      .$castTo<LinkTreeItemJoinedRow>()
  }

  /**
   * Checks every existing Link an Item names, and fetches the metadata of every
   * URL Item, before any transaction opens.
   *
   * @param domainId - The tree's Domain.
   * @param inputs - The Items, in order.
   * @returns The Items, ready for `writeItems`.
   * @throws {HttpError} 400 naming each Item whose Link is missing, on another
   *   Domain, archived, or itself a Link Tree.
   */
  private async prepareItems(
    domainId: string,
    inputs: LinkTreeItemInput[],
  ): Promise<PreparedItem[]> {
    const ids = inputs.flatMap((item) => ("link_id" in item ? [item.link_id] : []))
    const links = ids.length
      ? await this.db
          .selectFrom("links")
          .select(["id", "domain_id", "type", "status", "name", "slug"])
          .where("id", "in", ids)
          .execute()
      : []
    const byId = new Map(links.map((link) => [link.id, link]))

    const issues: { code: "custom"; path: (string | number)[]; message: string }[] = []
    inputs.forEach((item, i) => {
      if (!("link_id" in item)) return
      const link = byId.get(item.link_id)
      const problem = !link
        ? "link not found"
        : link.domain_id !== domainId
          ? "must be a link on the tree's domain"
          : link.type === "tree"
            ? "a link tree cannot list another link tree"
            : link.status === "archived"
              ? "link is archived"
              : null
      if (problem) issues.push({ code: "custom", path: ["items", i, "link_id"], message: problem })
    })
    if (issues.length) throw HttpError.validation("request validation failed", issues)

    return Promise.all(
      inputs.map(async (item): Promise<PreparedItem> => {
        if ("link_id" in item) {
          const link = byId.get(item.link_id)!
          return { label: item.label ?? link.name ?? link.slug, link_id: item.link_id }
        }
        const prepared = await this.linkService.prepare({
          domain_id: domainId,
          destination: item.url,
          // The Item's title also names the new short Link, so it reads the
          // same in Short links; without one, the destination's title is fetched.
          ...(item.label ? { name: item.label } : {}),
          tags: [],
          forward_query_params: true,
          preset_params: {},
          listed: false,
          rules: [],
        })
        return { label: item.label, prepared }
      }),
    )
  }

  /**
   * Writes the Items in order, creating the short Link behind each URL Item.
   *
   * @param tx - The transaction the writes join.
   * @param treeId - id of the tree's Link.
   * @param items - What `prepareItems` returned.
   * @returns The Links created for URL Items, for the caller to clear from the cache.
   */
  private async writeItems(tx: Db, treeId: string, items: PreparedItem[]): Promise<LinkRow[]> {
    const created: LinkRow[] = []
    const rows = []
    for (const [position, item] of items.entries()) {
      let linkId: string
      let label: string
      if ("prepared" in item) {
        const link = await this.linkService.insertPrepared(tx, item.prepared)
        created.push(link)
        linkId = link.id
        label = item.label ?? link.name ?? link.slug
      } else {
        linkId = item.link_id
        label = item.label
      }
      rows.push({ id: Bun.randomUUIDv7(), tree_id: treeId, position, label, link_id: linkId })
    }
    if (rows.length) await tx.insertInto("link_tree_items").values(rows).execute()
    return created
  }
}
