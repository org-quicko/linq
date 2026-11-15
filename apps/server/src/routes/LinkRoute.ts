import {
  ApiError,
  linkCountQuerySchema,
  linkCreateSchema,
  linkListQuerySchema,
  linkPatchSchema,
} from "@linq/shared"
import { Hono } from "hono"
import { isReservedSlug } from "../config.ts"
import { type Env, linkKeys } from "../libs/index.ts"
import { assertCan, idParam, validate } from "../middleware/index.ts"
import {
  archiveLink,
  countLinks,
  createLink,
  getLink,
  listLinks,
  listTags,
  loadLink,
  purgeArchivedLinks,
  purgeLink,
  updateLink,
} from "../services/index.ts"

/** Routes for `/links`. Every write clears the link's cached redirect and its domain's llms.txt. */
export const linkRoute = new Hono<Env>()
  .get("/", validate("query", linkListQuerySchema), async (c) => {
    const q = c.req.valid("query")
    const { data, total } = await listLinks(c.var.db, q)
    return c.json({ data, total, limit: q.limit, offset: q.offset })
  })

  /**
   * Just the count, for the client's sidebar badges. Registered ahead of `/:id`
   * so "count" is never swallowed by that route's uuid param.
   */
  .get("/count", validate("query", linkCountQuerySchema), async (c) =>
    c.json({ total: await countLinks(c.var.db, c.req.valid("query").status) }),
  )

  .post("/", validate("json", linkCreateSchema), async (c) => {
    assertCan(c.var.principal, "create", "Link")
    const body = c.req.valid("json")
    const { LINQ_CLIENT_BASE_PATH: clientBasePath, LINQ_SLUG_LENGTH: slugLength } = c.var.config
    if (body.slug && isReservedSlug(body.slug, clientBasePath)) {
      throw ApiError.validation("request validation failed", [
        { code: "custom", path: ["slug"], message: "slug is reserved" },
      ])
    }
    const fetched = await c.var.metadata.fetch(body.destination)
    const row = await createLink(c.var.db, body, fetched, { slugLength, clientBasePath })
    // Clears the negative entry left behind while this slug was 404ing.
    await c.var.cache.del(...linkKeys(row.domain_id, row.slug))
    return c.json(await getLink(c.var.db, row.id), 201)
  })

  .get("/:id", idParam, async (c) => c.json(await getLink(c.var.db, c.req.valid("param").id)))

  .patch("/:id", idParam, validate("json", linkPatchSchema), async (c) => {
    const { id } = c.req.valid("param")
    const patch = c.req.valid("json")
    const existing = await loadLink(c.var.db, id)
    // Archiving or restoring (a status change) is admin-only; every other
    // field is an ordinary edit. See resources/docs/adr/0016.
    assertCan(c.var.principal, patch.status !== undefined ? "archive" : "update", "Link")
    const fetched =
      patch.destination !== undefined ? await c.var.metadata.fetch(patch.destination) : null
    await updateLink(c.var.db, existing, patch, fetched)
    await c.var.cache.del(...linkKeys(existing.domain_id, existing.slug))
    return c.json(await getLink(c.var.db, id))
  })

  /**
   * "Empty archive": destroys every archived link in one call. Registered ahead
   * of `/:id` for the same reason as `/count`.
   */
  .delete("/purge", async (c) => {
    assertCan(c.var.principal, "purge", "Link")
    const rows = await purgeArchivedLinks(c.var.db)
    await c.var.cache.del(...rows.flatMap((row) => linkKeys(row.domain_id, row.slug)))
    return c.json({ purged: rows.length })
  })

  /** DELETE is an alias for archiving. Admin only, same as restoring — see resources/docs/adr/0016. */
  .delete("/:id", idParam, async (c) => {
    const { id } = c.req.valid("param")
    const existing = await loadLink(c.var.db, id)
    assertCan(c.var.principal, "archive", "Link")
    await archiveLink(c.var.db, id)
    await c.var.cache.del(...linkKeys(existing.domain_id, existing.slug))
    return c.json(await getLink(c.var.db, id))
  })

  /** Admin only, and archived-first, so a live short URL can never be destroyed by one call. */
  .delete("/:id/purge", idParam, async (c) => {
    assertCan(c.var.principal, "purge", "Link")
    const existing = await loadLink(c.var.db, c.req.valid("param").id)
    await purgeLink(c.var.db, existing)
    await c.var.cache.del(...linkKeys(existing.domain_id, existing.slug))
    return c.body(null, 204)
  })

/** `/tags`: tags in use on active links, most used first. */
export const tagRoute = new Hono<Env>().get("/", async (c) => c.json(await listTags(c.var.db)))
