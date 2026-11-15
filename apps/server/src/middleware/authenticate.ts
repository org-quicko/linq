import { ApiError, claimsSchema, defineAbility } from "@linq/shared"
import { createMiddleware } from "hono/factory"
import type { Env } from "../libs/index.ts"
import { findApiKeyByToken } from "../services/ApiKeyService.ts"

/**
 * Resolves the caller's key from `Authorization: Bearer <key>` (or, failing
 * that header entirely, `x-api-key`) and sets `c.var.principal`. 401 on a
 * missing, unknown or expired key.
 */
export const authenticate = createMiddleware<Env>(async (c, next) => {
  const authorization = c.req.header("authorization")
  let token: string | null
  if (authorization) {
    const [scheme, ...rest] = authorization.split(" ")
    token = scheme?.toLowerCase() === "bearer" && rest.length ? rest.join(" ").trim() || null : null
  } else {
    token = c.req.header("x-api-key")?.trim() || null
  }
  if (!token) throw ApiError.unauthorized("missing API key")

  const row = await findApiKeyByToken(c.var.db, token)
  if (!row) throw ApiError.unauthorized()
  if (row.expires_at && row.expires_at.getTime() <= Date.now())
    throw ApiError.unauthorized("API key has expired")

  const claims = claimsSchema.parse(row.claims)
  c.set("principal", { keyId: row.id, name: row.name, claims, ability: defineAbility(claims) })
  await next()
})
