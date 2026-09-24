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
import { Hono } from "hono"
import { z } from "zod"
import { createApiKey } from "../../auth/mint.ts"
import { assertCan } from "../../auth/permissions.ts"
import type { Selectable } from "kysely"
import type { DB } from "../../db/types.generated.ts"
import type { Env } from "../env.ts"
import { validate } from "../validate.ts"

const idParam = validate("param", z.object({ id: uuidSchema }))
const resolvedClaims = (value: { preset?: keyof typeof claimsForPreset; claims?: unknown }) =>
  value.preset ? [...claimsForPreset[value.preset]] : claimsSchema.parse(value.claims)

export function toApiKey(row: Selectable<DB["api_keys"]>): ApiKey {
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
      .selectFrom("api_keys")
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .offset(offset)
      .execute()
    const total = await c.var.db.selectFrom("api_keys").select((eb) => eb.fn.countAll<number>().as("value")).executeTakeFirst()
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
    const row = await c.var.db
      .selectFrom("api_keys")
      .selectAll()
      .where("id", "=", c.req.valid("param").id)
      .limit(1)
      .executeTakeFirst()
    if (!row) throw ApiError.notFound("key")
    return c.json(toApiKey(row))
  })
  .patch("/:id", idParam, validate("json", keyPatchSchema), async (c) => {
    assertCan(c.var.principal, "update", "Key")
    const { id } = c.req.valid("param")
    const patch = c.req.valid("json")
    if ((patch.claims !== undefined || patch.preset !== undefined) && id === c.var.principal.keyId)
      throw ApiError.forbidden("you cannot change the claims of the key you are using")
    const row = await c.var.db
      .updateTable("api_keys")
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.claims !== undefined || patch.preset !== undefined
          ? { claims: JSON.stringify(resolvedClaims(patch)) }
          : {}),
        ...(patch.expires_at !== undefined
          ? { expires_at: patch.expires_at ? new Date(patch.expires_at) : null }
          : {}),
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst()
    if (!row) throw ApiError.notFound("key")
    return c.json(toApiKey(row))
  })
  .delete("/:id", idParam, async (c) => {
    assertCan(c.var.principal, "delete", "Key")
    const { id } = c.req.valid("param")
    if (id === c.var.principal.keyId)
      throw ApiError.forbidden("you cannot revoke the key you are using")
    const row = await c.var.db
      .deleteFrom("api_keys")
      .where("id", "=", id)
      .returning("id")
      .executeTakeFirst()
    if (!row) throw ApiError.notFound("key")
    return c.body(null, 204)
  })
