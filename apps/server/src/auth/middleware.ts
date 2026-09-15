import { ApiError, type Role } from "@linq/shared"
import { eq } from "drizzle-orm"
import { createMiddleware } from "hono/factory"
import { apiKeys, users } from "../db/schema.ts"
import type { Env } from "../http/env.ts"
import { hashKey } from "./keys.ts"

export type Principal = { userId: string; role: Role; keyId: string }

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

/** Rejects a missing, unknown, expired or disabled-owner key with 401. */
export const authenticate = createMiddleware<Env>(async (c, next) => {
  const token = extractToken(c.req.raw.headers)
  if (!token) throw ApiError.unauthorized("missing API key")

  const [row] = await c.var.db
    .select({
      keyId: apiKeys.id,
      expiresAt: apiKeys.expiresAt,
      userId: users.id,
      role: users.role,
      status: users.status,
    })
    .from(apiKeys)
    .innerJoin(users, eq(apiKeys.userId, users.id))
    .where(eq(apiKeys.keyHash, hashKey(token)))
    .limit(1)

  if (!row) throw ApiError.unauthorized()
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    throw ApiError.unauthorized("API key has expired")
  }
  if (row.status === "disabled") throw ApiError.unauthorized("user is disabled")

  c.set("principal", { userId: row.userId, role: row.role, keyId: row.keyId })
  await next()
})
