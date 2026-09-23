import {
  ApiError,
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
import { assertRole } from "../../auth/permissions.ts"
import { apiKeys } from "../../db/schema.ts"
import type { Env } from "../env.ts"
import { validate } from "../validate.ts"

const idParam = validate("param", z.object({ id: uuidSchema }))

/** Maps a key row to the JSON shape the API returns. The secret is absent by construction. */
export function toApiKey(row: typeof apiKeys.$inferSelect): ApiKey {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    prefix: row.prefix,
    expires_at: row.expires_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

/**
 * Keys are the principals, so this is also the user administration surface.
 *
 * Every role may list keys, but only an admin sees more than
 * `{ id, name, role }` — `prefix`, `expires_at` and the timestamps stay
 * admin-only, since nothing else in the UI needs them.
 */
export const keyRoutes = new Hono<Env>()
  .get("/", validate("query", paginationSchema), async (c) => {
    const { limit, offset } = c.req.valid("query")
    const isAdmin = c.var.principal.role === "admin"

    const rows = await c.var.db
      .select()
      .from(apiKeys)
      .orderBy(asc(apiKeys.name))
      .limit(limit)
      .offset(offset)
    const [total] = await c.var.db.select({ value: count() }).from(apiKeys)

    const data: (ApiKey | ApiKeySummary)[] = rows.map((row) =>
      isAdmin ? toApiKey(row) : { id: row.id, name: row.name, role: row.role },
    )
    return c.json({ data, total: total?.value ?? 0, limit, offset })
  })

  /** The only response that ever carries the plaintext secret. */
  .post("/", validate("json", keyCreateSchema), async (c) => {
    assertRole(c.var.principal, "admin")
    const body = c.req.valid("json")

    const { row, secret } = await createApiKey(c.var.db, {
      name: body.name,
      role: body.role,
      expires_at: body.expires_at ? new Date(body.expires_at) : null,
    })

    const created: ApiKeyCreated = { ...toApiKey(row), secret }
    return c.json(created, 201)
  })

  .get("/:id", idParam, async (c) => {
    assertRole(c.var.principal, "admin")
    const [row] = await c.var.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, c.req.valid("param").id))
      .limit(1)
    if (!row) throw ApiError.notFound("key")
    return c.json(toApiKey(row))
  })

  .patch("/:id", idParam, validate("json", keyPatchSchema), async (c) => {
    assertRole(c.var.principal, "admin")
    const { id } = c.req.valid("param")
    const patch = c.req.valid("json")

    // The one-way door out of admin: an admin who demotes its own key cannot
    // undo it with that key.
    if (patch.role !== undefined && id === c.var.principal.keyId) {
      throw ApiError.forbidden("you cannot change the role of the key you are using")
    }

    const [row] = await c.var.db
      .update(apiKeys)
      .set({
        // Spelled out rather than spread: `expires_at` arrives as an ISO string
        // and the column takes a Date, so a blanket spread would not typecheck.
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.role !== undefined ? { role: patch.role } : {}),
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

  /**
   * Revocation is a real delete: a revoked key has no history worth keeping.
   * Links carry no owner (docs/adr/0016), so there is nothing left to strand —
   * revoking is unconditional either way.
   */
  .delete("/:id", idParam, async (c) => {
    assertRole(c.var.principal, "admin")
    const { id } = c.req.valid("param")

    // Revoking the calling key would lock this instance out of its own API with
    // only `bun run key:create` left as a way back.
    if (id === c.var.principal.keyId) {
      throw ApiError.forbidden("you cannot revoke the key you are using")
    }

    const [row] = await c.var.db
      .delete(apiKeys)
      .where(eq(apiKeys.id, id))
      .returning({ id: apiKeys.id })
    if (!row) throw ApiError.notFound("key")
    return c.body(null, 204)
  })
