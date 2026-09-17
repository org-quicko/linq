import { ApiError, type Role } from "@linq/shared"
import { eq } from "drizzle-orm"
import { createMiddleware } from "hono/factory"
import { apiKeys } from "../db/schema.ts"
import type { Env } from "../http/env.ts"
import { hashKey } from "./keys.ts"

/**
 * The calling key. There is no user behind it: a key holds its own name and
 * role, so authentication is one row and no join. See docs/adr/0011.
 */
export type Principal = { keyId: string; role: Role; name: string }

/** `Authorization: Bearer <key>`, falling back to `X-Api-Key`. */
export function extractToken(headers: Headers): string | null {
  const auth = headers.get("authorization")
  if (auth) {
    const [scheme, ...rest] = auth.split(" ")
    if (scheme?.toLowerCase() === "bearer" && rest.length) return rest.join(" ").trim() || null
    return null
  }
  return headers.get("x-api-key")?.trim() || null
}

/** Rejects a missing, unknown or expired key with 401. */
export const authenticate = createMiddleware<Env>(async (c, next) => {
  const token = extractToken(c.req.raw.headers)
  if (!token) throw ApiError.unauthorized("missing API key")

  const [row] = await c.var.db
    .select({
      keyId: apiKeys.id,
      name: apiKeys.name,
      role: apiKeys.role,
      expiresAt: apiKeys.expiresAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hashKey(token)))
    .limit(1)

  if (!row) throw ApiError.unauthorized()
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    throw ApiError.unauthorized("API key has expired")
  }

  // `name` rides along so /me needs no second query.
  c.set("principal", { keyId: row.keyId, role: row.role, name: row.name })
  await next()
})
