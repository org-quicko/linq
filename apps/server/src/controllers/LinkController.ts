import {
  idParamSchema,
  linkCountQuerySchema,
  linkCreateSchema,
  linkListQuerySchema,
  linkPatchSchema,
  rulesPutSchema,
} from "@linq/shared"
import type { Context } from "hono"
import { Log } from "../libs/index.ts"
import { authorize } from "../middleware/index.ts"
import type { LinkService } from "../services/index.ts"
import { RequestUtil } from "../utils/index.ts"

/**
 * HTTP layer for links, their rules (`/links/:id/rules`) and the tags in use
 * (`/tags`). Validates the request, asks the permission question, and hands
 * the rest to `LinkService`, which owns every query and clears the cache on
 * every write.
 */
export class LinkController {
  /**
   * @param linkService - Link queries and business rules.
   */
  constructor(private readonly linkService: LinkService) {}

  /**
   * GET /links
   * Lists one filtered, sorted page of links.
   *
   * @param c - Hono request context; accepts the `linkListQuerySchema` query params.
   * @returns JSON `{ data, total, limit, offset }`.
   * @throws {HttpError} 400 if the query does not validate.
   */
  @Log("linkController.list")
  list = async (c: Context) => {
    const q = await RequestUtil.parse(c, "query", linkListQuerySchema)
    const { data, total } = await this.linkService.list(q)
    return c.json({ data, total, limit: q.limit, offset: q.offset })
  }

  /**
   * GET /links/count
   * Counts links, for the client's sidebar badges.
   *
   * @param c - Hono request context; accepts optional `status` and `type` query params.
   * @returns JSON `{ total }`.
   * @throws {HttpError} 400 if the query does not validate.
   */
  @Log("linkController.count")
  count = async (c: Context) => {
    const { status, type } = await RequestUtil.parse(c, "query", linkCountQuerySchema)
    return c.json({ total: await this.linkService.count(status, type) })
  }

  /**
   * POST /links
   * Creates a link.
   *
   * @param c - Hono request context; expects a `linkCreateSchema` JSON body.
   * @returns JSON response with the created link, 201.
   * @throws {HttpError} 400 if the body does not validate or the slug is reserved.
   * @throws {HttpError} 403 if the key may not create links.
   * @throws {HttpError} 404 if the domain does not exist.
   * @throws {HttpError} 409 if the domain is archived or the slug is taken.
   */
  @Log("linkController.create")
  create = async (c: Context) => {
    const body = await RequestUtil.parse(c, "json", linkCreateSchema)
    authorize(c.var.principal, "create", "Link")
    return c.json(await this.linkService.create(body), 201)
  }

  /**
   * GET /links/:id
   * Fetches a single link.
   *
   * @param c - Hono request context; expects an `id` route param.
   * @returns JSON response with the link.
   * @throws {HttpError} 400 if the id is not a UUID.
   * @throws {HttpError} 404 if no link matches the id.
   */
  @Log("linkController.get")
  get = async (c: Context) => {
    const { id } = await RequestUtil.parse(c, "param", idParamSchema)
    return c.json(await this.linkService.get(id))
  }

  /**
   * PATCH /links/:id
   * Partially updates a link. Archiving or restoring (a status change) is
   * admin-only; every other field is an ordinary edit. See resources/docs/adr/0016.
   *
   * @param c - Hono request context; expects an `id` route param and a `linkPatchSchema` JSON body.
   * @returns JSON response with the updated link.
   * @throws {HttpError} 400 if the id or body does not validate.
   * @throws {HttpError} 403 if the key may not make this change.
   * @throws {HttpError} 404 if no link matches the id.
   */
  @Log("linkController.update")
  update = async (c: Context) => {
    const { id } = await RequestUtil.parse(c, "param", idParamSchema)
    const patch = await RequestUtil.parse(c, "json", linkPatchSchema)
    const existing = await this.linkService.load(id)
    authorize(c.var.principal, patch.status !== undefined ? "archive" : "update", "Link")
    return c.json(await this.linkService.update(existing, patch))
  }

  /**
   * DELETE /links/:id
   * Archives a link: DELETE is an alias for archiving. Admin only, same as
   * restoring. See resources/docs/adr/0016.
   *
   * @param c - Hono request context; expects an `id` route param.
   * @returns JSON response with the archived link.
   * @throws {HttpError} 400 if the id is not a UUID.
   * @throws {HttpError} 403 if the key may not archive links.
   * @throws {HttpError} 404 if no link matches the id.
   */
  @Log("linkController.archive")
  archive = async (c: Context) => {
    const { id } = await RequestUtil.parse(c, "param", idParamSchema)
    const existing = await this.linkService.load(id)
    authorize(c.var.principal, "archive", "Link")
    return c.json(await this.linkService.archive(existing))
  }

  /**
   * DELETE /links/:id/purge
   * Destroys one archived link for good. Admin only, and archived-first, so a
   * live short URL can never be destroyed by one call.
   *
   * @param c - Hono request context; expects an `id` route param.
   * @returns Empty 204 response.
   * @throws {HttpError} 400 if the id is not a UUID.
   * @throws {HttpError} 403 if the key may not purge links.
   * @throws {HttpError} 404 if no link matches the id.
   * @throws {HttpError} 409 if the link is not archived.
   */
  @Log("linkController.purge")
  purge = async (c: Context) => {
    const { id } = await RequestUtil.parse(c, "param", idParamSchema)
    authorize(c.var.principal, "purge", "Link")
    await this.linkService.purge(await this.linkService.load(id))
    return c.body(null, 204)
  }

  /**
   * DELETE /links/purge
   * "Empty archive": destroys every archived link in one call.
   *
   * @param c - Hono request context.
   * @returns JSON `{ purged }`, the number of links destroyed.
   * @throws {HttpError} 403 if the key may not purge links.
   */
  @Log("linkController.purgeArchived")
  purgeArchived = async (c: Context) => {
    authorize(c.var.principal, "purge", "Link")
    return c.json({ purged: await this.linkService.purgeArchived() })
  }

  /**
   * GET /links/:id/rules
   * Lists a link's routing rules, in order.
   *
   * @param c - Hono request context; expects an `id` route param.
   * @returns JSON array of rules.
   * @throws {HttpError} 400 if the id is not a UUID.
   * @throws {HttpError} 404 if no link matches the id.
   */
  @Log("linkController.listRules")
  listRules = async (c: Context) => {
    const { id } = await RequestUtil.parse(c, "param", idParamSchema)
    return c.json(await this.linkService.listRules(id))
  }

  /**
   * PUT /links/:id/rules
   * Replaces a link's whole ordered rule set; the server owns `position`.
   *
   * @param c - Hono request context; expects an `id` route param and a `rulesPutSchema` JSON body.
   * @returns JSON array of the rules as stored.
   * @throws {HttpError} 400 if the id or body does not validate.
   * @throws {HttpError} 403 if the key may not update links.
   * @throws {HttpError} 404 if no link matches the id.
   */
  @Log("linkController.replaceRules")
  replaceRules = async (c: Context) => {
    const { id } = await RequestUtil.parse(c, "param", idParamSchema)
    const rules = await RequestUtil.parse(c, "json", rulesPutSchema)
    const link = await this.linkService.load(id)
    authorize(c.var.principal, "update", "Link")
    return c.json(await this.linkService.replaceRules(link, rules))
  }

  /**
   * GET /tags
   * Lists the tags in use on active links, most used first.
   *
   * @param c - Hono request context.
   * @returns JSON array of `{ tag, count }`.
   */
  @Log("linkController.listTags")
  listTags = async (c: Context) => c.json(await this.linkService.listTags())
}
