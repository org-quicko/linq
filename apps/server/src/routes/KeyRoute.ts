import {
  ApiError,
  type ApiKeyCreated,
  keyCreateSchema,
  keyPatchSchema,
  paginationSchema,
} from "@linq/shared"
import { Hono } from "hono"
import type { Env } from "../libs/index.ts"
import { assertCan, idParam, validate } from "../middleware/index.ts"
import {
  createApiKey,
  deleteApiKey,
  getApiKey,
  listApiKeys,
  resolveClaims,
  toApiKey,
  updateApiKey,
} from "../services/index.ts"

/**
 * Routes for `/keys`. Two self-guards a claim cannot express: a key may not
 * change its own claims, and may not revoke itself.
 */
export const keyRoute = new Hono<Env>()
  .get("/", validate("query", paginationSchema), async (c) => {
    assertCan(c.var.principal, "read", "Key")
    const { limit, offset } = c.req.valid("query")
    const canManage = c.var.principal.ability.can("create", "Key")
    const { data, total } = await listApiKeys(c.var.db, { limit, offset, canManage })
    return c.json({ data, total, limit, offset })
  })
  .post("/", validate("json", keyCreateSchema), async (c) => {
    assertCan(c.var.principal, "create", "Key")
    const body = c.req.valid("json")
    const { row, secret } = await createApiKey(c.var.db, {
      name: body.name,
      claims: resolveClaims(body),
      expiresAt: body.expires_at ? new Date(body.expires_at) : null,
    })
    return c.json({ ...toApiKey(row), secret } satisfies ApiKeyCreated, 201)
  })
  .get("/:id", idParam, async (c) => {
    assertCan(c.var.principal, "read", "Key")
    const key = await getApiKey(c.var.db, c.req.valid("param").id)
    if (!key) throw ApiError.notFound("key")
    return c.json(key)
  })
  .patch("/:id", idParam, validate("json", keyPatchSchema), async (c) => {
    assertCan(c.var.principal, "update", "Key")
    const { id } = c.req.valid("param")
    const patch = c.req.valid("json")
    const changesClaims = patch.claims !== undefined || patch.preset !== undefined
    if (changesClaims && id === c.var.principal.keyId)
      throw ApiError.forbidden("you cannot change the claims of the key you are using")
    const key = await updateApiKey(c.var.db, id, {
      name: patch.name,
      claims: changesClaims ? resolveClaims(patch) : undefined,
      expiresAt:
        patch.expires_at === undefined
          ? undefined
          : patch.expires_at
            ? new Date(patch.expires_at)
            : null,
    })
    if (!key) throw ApiError.notFound("key")
    return c.json(key)
  })
  .delete("/:id", idParam, async (c) => {
    assertCan(c.var.principal, "delete", "Key")
    const { id } = c.req.valid("param")
    if (id === c.var.principal.keyId)
      throw ApiError.forbidden("you cannot revoke the key you are using")
    if (!(await deleteApiKey(c.var.db, id))) throw ApiError.notFound("key")
    return c.body(null, 204)
  })

/**
 * `/me`: the calling key itself. The Client UI gates its menus on this, and its
 * server probe uses it to tell a linq instance from anything else that answers.
 */
export const meRoute = new Hono<Env>().get("/", async (c) => {
  const key = await getApiKey(c.var.db, c.var.principal.keyId)
  // The key authenticated moments ago, so its row cannot be missing without a
  // concurrent revoke.
  if (!key) throw new Error("the calling key vanished mid-request")
  return c.json(key)
})
