import { ApiError, claimsSchema, defineAbility, type AppAbility, type Claim } from "@linq/shared"
import { createMiddleware } from "hono/factory"
import type { Env } from "../http/env.ts"
import { hashKey } from "./keys.ts"

/** A key is the principal; its CASL ability is built once after authentication. */
export type Principal = { keyId: string; claims: Claim[]; ability: AppAbility; name: string }

export function extractToken(headers: Headers): string | null {
  const auth = headers.get("authorization")
  if (auth) {
    const [scheme, ...rest] = auth.split(" ")
    if (scheme?.toLowerCase() === "bearer" && rest.length) return rest.join(" ").trim() || null
    return null
  }
  return headers.get("x-api-key")?.trim() || null
}

export const authenticate = createMiddleware<Env>(async (c, next) => {
  const token = extractToken(c.req.raw.headers)
  if (!token) throw ApiError.unauthorized("missing API key")
  const row = await c.var.db
    .selectFrom("api_keys")
    .select(["id as keyId", "name", "claims", "expires_at"])
    .where("key_hash", "=", hashKey(token))
    .limit(1)
    .executeTakeFirst()
  if (!row) throw ApiError.unauthorized()
  if (row.expires_at && row.expires_at.getTime() <= Date.now())
    throw ApiError.unauthorized("API key has expired")
  const claims = claimsSchema.parse(row.claims)
  c.set("principal", { keyId: row.keyId, name: row.name, claims, ability: defineAbility(claims) })
  await next()
})
