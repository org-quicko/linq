import { type ApiKeyCreated, keyCreateSchema, keyPatchSchema, paginationSchema } from "@linq/shared"
import type { Context } from "hono"
import {
  ApiKeyCreateBodyToApiKeyCreateInputConverter,
  ApiKeyPatchBodyToApiKeyPatchInputConverter,
  ApiKeyRowToApiKeyConverter,
} from "../converters/index.ts"
import { HttpError } from "../libs/index.ts"
import { authorize, idParamSchema, parseRequest } from "../middleware/index.ts"
import type { ApiKeyService } from "../services/index.ts"

const apiKeyCreateBodyToApiKeyCreateInputConverter =
  new ApiKeyCreateBodyToApiKeyCreateInputConverter()
const apiKeyPatchBodyToApiKeyPatchInputConverter = new ApiKeyPatchBodyToApiKeyPatchInputConverter()
const apiKeyRowToApiKeyConverter = new ApiKeyRowToApiKeyConverter()

/**
 * HTTP layer for `/keys` and `/me`. Adds two self-guards a claim cannot
 * express: a key may not change its own claims, and may not revoke itself.
 */
export class ApiKeyController {
  /**
   * @param apiKeyService - API key queries.
   */
  constructor(private readonly apiKeyService: ApiKeyService) {}

  /**
   * GET /keys
   * Lists one page of keys, newest first; the summary shape unless the caller may manage keys.
   *
   * @param c - Hono request context; accepts `limit` and `offset` query params.
   * @returns JSON `{ data, total, limit, offset }`.
   * @throws {HttpError} 400 if the query does not validate.
   * @throws {HttpError} 403 if the key may not read keys.
   */
  list = async (c: Context) => {
    const { limit, offset } = await parseRequest(c, "query", paginationSchema)
    authorize(c.var.principal, "read", "Key")
    const canManage = c.var.principal.ability.can("create", "Key")
    const { data, total } = await this.apiKeyService.list({ limit, offset, canManage })
    return c.json({ data, total, limit, offset })
  }

  /**
   * POST /keys
   * Mints a key. The plaintext secret is in this response and nowhere else, ever.
   *
   * @param c - Hono request context; expects a `keyCreateSchema` JSON body.
   * @returns JSON response with the key and its `secret`, 201.
   * @throws {HttpError} 400 if the body does not validate.
   * @throws {HttpError} 403 if the key may not create keys.
   */
  create = async (c: Context) => {
    const body = await parseRequest(c, "json", keyCreateSchema)
    authorize(c.var.principal, "create", "Key")
    const { row, secret } = await this.apiKeyService.create(
      apiKeyCreateBodyToApiKeyCreateInputConverter.convertFrom(body),
    )
    return c.json(
      { ...apiKeyRowToApiKeyConverter.convertFrom(row), secret } satisfies ApiKeyCreated,
      201,
    )
  }

  /**
   * GET /keys/:id
   * Fetches a single key.
   *
   * @param c - Hono request context; expects an `id` route param.
   * @returns JSON response with the key.
   * @throws {HttpError} 400 if the id is not a UUID.
   * @throws {HttpError} 403 if the key may not read keys.
   * @throws {HttpError} 404 if no key matches the id.
   */
  get = async (c: Context) => {
    const { id } = await parseRequest(c, "param", idParamSchema)
    authorize(c.var.principal, "read", "Key")
    const key = await this.apiKeyService.get(id)
    if (!key) throw HttpError.notFound("key")
    return c.json(key)
  }

  /**
   * PATCH /keys/:id
   * Renames a key, changes its claims or its expiry.
   *
   * @param c - Hono request context; expects an `id` route param and a `keyPatchSchema` JSON body.
   * @returns JSON response with the updated key.
   * @throws {HttpError} 400 if the id or body does not validate.
   * @throws {HttpError} 403 if the key may not update keys, or is changing its own claims.
   * @throws {HttpError} 404 if no key matches the id.
   */
  update = async (c: Context) => {
    const { id } = await parseRequest(c, "param", idParamSchema)
    const body = await parseRequest(c, "json", keyPatchSchema)
    authorize(c.var.principal, "update", "Key")
    const patch = apiKeyPatchBodyToApiKeyPatchInputConverter.convertFrom(body)
    if (patch.claims !== undefined && id === c.var.principal.keyId)
      throw HttpError.forbidden("you cannot change the claims of the key you are using")
    const key = await this.apiKeyService.update(id, patch)
    if (!key) throw HttpError.notFound("key")
    return c.json(key)
  }

  /**
   * DELETE /keys/:id
   * Revokes a key, for good.
   *
   * @param c - Hono request context; expects an `id` route param.
   * @returns Empty 204 response.
   * @throws {HttpError} 400 if the id is not a UUID.
   * @throws {HttpError} 403 if the key may not delete keys, or is revoking itself.
   * @throws {HttpError} 404 if no key matches the id.
   */
  delete = async (c: Context) => {
    const { id } = await parseRequest(c, "param", idParamSchema)
    authorize(c.var.principal, "delete", "Key")
    if (id === c.var.principal.keyId)
      throw HttpError.forbidden("you cannot revoke the key you are using")
    if (!(await this.apiKeyService.delete(id))) throw HttpError.notFound("key")
    return c.body(null, 204)
  }

  /**
   * GET /me
   * The calling key itself. The Client UI gates its menus on this, and its
   * server probe uses it to tell a linq instance from anything else that answers.
   *
   * @param c - Hono request context.
   * @returns JSON response with the calling key.
   */
  me = async (c: Context) => {
    const key = await this.apiKeyService.get(c.var.principal.keyId)
    // The key authenticated moments ago, so its row cannot be missing without a
    // concurrent revoke.
    if (!key) throw new Error("the calling key vanished mid-request")
    return c.json(key)
  }
}
