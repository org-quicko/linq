import { claimsSchema, PermissionUtil, type Principal } from "@linq/shared"
import { createMiddleware } from "hono/factory"
import { HttpError } from "../libs/index.ts"
import type { ApiKeyService } from "../services/index.ts"

/**
 * Types `c.var.principal` / `c.get("principal")` on every Hono context, so a
 * controller taking a plain `Context` reads it without a Hono `Env` generic.
 */
declare module "hono" {
  interface ContextVariableMap {
    /** The authenticated API key, set by `authenticate` below; only present under /api/v1. */
    principal: Principal
  }
}

/**
 * Resolves the caller's key from `Authorization: Bearer <key>` (or, failing
 * that header entirely, `x-api-key`) and sets `c.var.principal`. 401 on a
 * missing, unknown or expired key.
 *
 * @param apiKeyService - The app's one `ApiKeyService`, which looks the token up.
 * @returns The middleware.
 */
export function authenticate(apiKeyService: ApiKeyService) {
  return createMiddleware(async (c, next) => {
    const authorization = c.req.header("authorization")
    let token: string | null
    if (authorization) {
      const [scheme, ...rest] = authorization.split(" ")
      token =
        scheme?.toLowerCase() === "bearer" && rest.length ? rest.join(" ").trim() || null : null
    } else {
      token = c.req.header("x-api-key")?.trim() || null
    }
    if (!token) throw HttpError.unauthorized("missing API key")

    const row = await apiKeyService.findByToken(token)
    if (!row) throw HttpError.unauthorized()
    if (row.expires_at && row.expires_at.getTime() <= Date.now())
      throw HttpError.unauthorized("API key has expired")

    const claims = claimsSchema.parse(row.claims)
    c.set("principal", {
      keyId: row.id,
      name: row.name,
      claims,
      ability: PermissionUtil.defineAbility(claims),
    })
    await next()
  })
}
