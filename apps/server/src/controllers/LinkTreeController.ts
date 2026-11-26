import { idParamSchema, linkTreeCreateSchema, linkTreePatchSchema } from "@linq/shared"
import type { Context } from "hono"
import { Log } from "../libs/index.ts"
import { authorize } from "../middleware/index.ts"
import type { LinkTreeService } from "../services/index.ts"
import { RequestUtil } from "../utils/index.ts"

/**
 * HTTP layer for Link Trees. A Link Tree is a Link, so it asks the same
 * permission questions a Link does; listing, archiving, restoring and purging
 * one go through `/links`.
 */
export class LinkTreeController {
  /**
   * @param linkTreeService - Link Tree queries and business rules.
   */
  constructor(private readonly linkTreeService: LinkTreeService) {}

  /**
   * POST /link-trees
   * Creates a Link Tree. An Item given as a URL becomes a new short Link on the
   * tree's Domain, which the same `create Link` permission covers.
   *
   * @param c - Hono request context; expects a `linkTreeCreateSchema` JSON body.
   * @returns JSON response with the created Link Tree, 201.
   * @throws {HttpError} 400 if the body does not validate, the slug is reserved, or an Item's Link is not usable.
   * @throws {HttpError} 403 if the key may not create links.
   * @throws {HttpError} 404 if the domain does not exist.
   * @throws {HttpError} 409 if the domain is archived or the slug is taken.
   */
  @Log("linkTreeController.create")
  create = async (c: Context) => {
    const body = await RequestUtil.parse(c, "json", linkTreeCreateSchema)
    authorize(c.var.principal, "create", "Link")
    return c.json(await this.linkTreeService.create(body), 201)
  }

  /**
   * GET /link-trees/:id
   * Fetches one Link Tree with its Items.
   *
   * @param c - Hono request context; expects an `id` route param.
   * @returns JSON response with the Link Tree.
   * @throws {HttpError} 400 if the id is not a UUID.
   * @throws {HttpError} 404 if no Link Tree matches the id.
   */
  @Log("linkTreeController.get")
  get = async (c: Context) => {
    const { id } = await RequestUtil.parse(c, "param", idParamSchema)
    return c.json(await this.linkTreeService.get(id))
  }

  /**
   * PATCH /link-trees/:id
   * Partially updates a Link Tree. `items`, when sent, replaces the whole list.
   *
   * @param c - Hono request context; expects an `id` route param and a `linkTreePatchSchema` JSON body.
   * @returns JSON response with the updated Link Tree.
   * @throws {HttpError} 400 if the id or body does not validate, or an Item's Link is not usable.
   * @throws {HttpError} 403 if the key may not update links, or creates one without permission to.
   * @throws {HttpError} 404 if no Link Tree matches the id.
   */
  @Log("linkTreeController.update")
  update = async (c: Context) => {
    const { id } = await RequestUtil.parse(c, "param", idParamSchema)
    const patch = await RequestUtil.parse(c, "json", linkTreePatchSchema)
    const existing = await this.linkTreeService.load(id)
    authorize(c.var.principal, "update", "Link")
    if (patch.items?.some((item) => "url" in item)) authorize(c.var.principal, "create", "Link")
    return c.json(await this.linkTreeService.update(existing, patch))
  }
}
