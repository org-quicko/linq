import {
  ApiError,
  claimsForPreset,
  claimsSchema,
  presetForClaims,
  type ApiKey,
  type ApiKeyCreated,
  type ApiKeySummary,
  keyCreateSchema,
  keyPatchSchema,
  paginationSchema,
  uuidSchema,
} from "@linq/shared"
import { asc, count, eq } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import { createApiKey } from "../../auth/mint.ts"
import { assertCan } from "../../auth/permissions.ts"
import { apiKeys } from "../../db/schema.ts"
import type { Env } from "../env.ts"
import { validate } from "../validate.ts"

const idParam = validate("param", z.object({ id: uuidSchema }))
const resolvedClaims = (value: { preset?: keyof typeof claimsForPreset; claims?: unknown }) =>
  value.preset ? [...claimsForPreset[value.preset]] : claimsSchema.parse(value.claims)

export function toApiKey(row: typeof apiKeys.$inferSelect): ApiKey {
  const claims = claimsSchema.parse(row.claims)
  return {
    id: row.id,
    name: row.name,
    claims,
    preset: presetForClaims(claims),
    prefix: row.prefix,
    expires_at: row.expires_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

export const keyRoutes = new Hono<Env>()
  .get("/", validate("query", paginationSchema), async (c) => {
    assertCan(c.var.principal, "read", "Key")
    const { limit, offset } = c.req.valid("query")
    const rows = await c.var.db
      .select()
      .from(apiKeys)
      .orderBy(asc(apiKeys.name))
      .limit(limit)
      .offset(offset)
    const [total] = await c.var.db.select({ value: count() }).from(apiKeys)
    const canManage = c.var.principal.ability.can("create", "Key")
    const data: (ApiKey | ApiKeySummary)[] = rows.map((row) => {
      const key = toApiKey(row)
      return canManage
        ? key
        : { id: key.id, name: key.name, claims: key.claims, preset: key.preset }
    })
    return c.json({ data, total: total?.value ?? 0, limit, offset })
  })
  .post("/", validate("json", keyCreateSchema), async (c) => {
    assertCan(c.var.principal, "create", "Key")
    const body = c.req.valid("json")
    const { row, secret } = await createApiKey(c.var.db, {
      name: body.name,
      claims: resolvedClaims(body),
      expires_at: body.expires_at ? new Date(body.expires_at) : null,
    })
    return c.json({ ...toApiKey(row), secret } satisfies ApiKeyCreated, 201)
  })
  .get("/:id", idParam, async (c) => {
    assertCan(c.var.principal, "read", "Key")
    const [row] = await c.var.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, c.req.valid("param").id))
      .limit(1)
    if (!row) throw ApiError.notFound("key")
    return c.json(toApiKey(row))
  })
  .patch("/:id", idParam, validate("json", keyPatchSchema), async (c) => {
    assertCan(c.var.principal, "update", "Key")
    const { id } = c.req.valid("param")
    const patch = c.req.valid("json")
    if ((patch.claims !== undefined || patch.preset !== undefined) && id === c.var.principal.keyId)
      throw ApiError.forbidden("you cannot change the claims of the key you are using")
    const [row] = await c.var.db
      .update(apiKeys)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.claims !== undefined || patch.preset !== undefined
          ? { claims: resolvedClaims(patch) }
          : {}),
        ...(patch.expires_at !== undefined
          ? { expires_at: patch.expires_at ? new Date(patch.expires_at) : null }
          : {}),
        updated_at: new Date(),
      })
      .where(eq(apiKeys.id, id))
      .returning()
    if (!row) throw ApiError.notFound("key")
    return c.json(toApiKey(row))
  })
  .delete("/:id", idParam, async (c) => {
    assertCan(c.var.principal, "delete", "Key")
    const { id } = c.req.valid("param")
    if (id === c.var.principal.keyId)
      throw ApiError.forbidden("you cannot revoke the key you are using")
    const [row] = await c.var.db
      .delete(apiKeys)
      .where(eq(apiKeys.id, id))
      .returning({ id: apiKeys.id })
    if (!row) throw ApiError.notFound("key")
    return c.body(null, 204)
  })
