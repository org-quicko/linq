import {
  ApiError,
  type ApiKey,
  type ApiKeyCreated,
  keyCreateSchema,
  paginationSchema,
  type User,
  userCreateSchema,
  userPatchSchema,
  uuidSchema,
} from "@linq/shared"
import { asc, count, eq } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import { generateKey, hashKey, keyPrefix } from "../../auth/keys.ts"
import { assertRole } from "../../auth/permissions.ts"
import { apiKeys, users } from "../../db/schema.ts"
import type { Env } from "../env.ts"
import { validate } from "../validate.ts"

const idParam = validate("param", z.object({ id: uuidSchema }))

/** Maps a user row to the JSON shape the API returns. */
function toUser(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** Maps an api key row to its JSON shape. The secret is absent by construction. */
function toApiKey(row: typeof apiKeys.$inferSelect): ApiKey {
  return {
    id: row.id,
    userId: row.userId,
    label: row.label,
    prefix: row.prefix,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

/** Email is optional but unique; checked up front so the caller gets a 409. */
async function assertEmailFree(c: { var: Env["Variables"] }, email: string, exceptId?: string) {
  const [clash] = await c.var.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
  if (clash && clash.id !== exceptId) throw ApiError.conflict(`email ${email} is already in use`)
}

export const userRoutes = new Hono<Env>()
  /** Every role may list users; only an admin sees more than `{id, name}`. */
  .get("/", validate("query", paginationSchema), async (c) => {
    const { limit, offset } = c.req.valid("query")
    const isAdmin = c.var.principal.role === "admin"

    const rows = await c.var.db
      .select()
      .from(users)
      .orderBy(asc(users.name))
      .limit(limit)
      .offset(offset)
    const [{ total }] = await c.var.db.select({ total: count() }).from(users)

    return c.json({
      data: rows.map((r) => (isAdmin ? toUser(r) : { id: r.id, name: r.name })),
      total,
      limit,
      offset,
    })
  })

  .post("/", validate("json", userCreateSchema), async (c) => {
    assertRole(c.var.principal, "admin")
    const body = c.req.valid("json")
    if (body.email) await assertEmailFree(c, body.email)

    const [row] = await c.var.db
      .insert(users)
      .values({
        id: Bun.randomUUIDv7(),
        name: body.name,
        email: body.email ?? null,
        role: body.role,
      })
      .returning()
    return c.json(toUser(row), 201)
  })

  .get("/:id", idParam, async (c) => {
    assertRole(c.var.principal, "admin")
    const [row] = await c.var.db
      .select()
      .from(users)
      .where(eq(users.id, c.req.valid("param").id))
      .limit(1)
    if (!row) throw ApiError.notFound("user")
    return c.json(toUser(row))
  })

  .patch("/:id", idParam, validate("json", userPatchSchema), async (c) => {
    assertRole(c.var.principal, "admin")
    const { id } = c.req.valid("param")
    const patch = c.req.valid("json")

    // Self-promotion and self-demotion are both out; role changes need a peer.
    if (patch.role !== undefined && id === c.var.principal.userId) {
      throw ApiError.forbidden("you cannot change your own role")
    }
    // A disabled user's keys all 401, and only an admin can re-enable one, so the
    // last admin disabling itself would lock the instance out of its own API.
    if (patch.status === "disabled" && id === c.var.principal.userId) {
      throw ApiError.forbidden("you cannot disable yourself")
    }
    if (patch.email) await assertEmailFree(c, patch.email, id)

    const [row] = await c.var.db
      .update(users)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning()
    if (!row) throw ApiError.notFound("user")
    return c.json(toUser(row))
  })

  .get("/:id/keys", idParam, async (c) => {
    assertRole(c.var.principal, "admin")
    const rows = await c.var.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.userId, c.req.valid("param").id))
      .orderBy(asc(apiKeys.createdAt))
    return c.json(rows.map(toApiKey))
  })

  /** The only response that ever carries the plaintext secret. */
  .post("/:id/keys", idParam, validate("json", keyCreateSchema), async (c) => {
    assertRole(c.var.principal, "admin")
    const { id } = c.req.valid("param")
    const body = c.req.valid("json")

    const [owner] = await c.var.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, id))
      .limit(1)
    if (!owner) throw ApiError.notFound("user")

    const secret = generateKey()
    const [row] = await c.var.db
      .insert(apiKeys)
      .values({
        id: Bun.randomUUIDv7(),
        userId: id,
        label: body.label,
        keyHash: hashKey(secret),
        prefix: keyPrefix(secret),
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      })
      .returning()

    const created: ApiKeyCreated = { ...toApiKey(row), secret }
    return c.json(created, 201)
  })

export const keyRoutes = new Hono<Env>().delete("/:id", idParam, async (c) => {
  assertRole(c.var.principal, "admin")
  // Revocation is a real delete: a revoked key has no history worth keeping.
  const [row] = await c.var.db
    .delete(apiKeys)
    .where(eq(apiKeys.id, c.req.valid("param").id))
    .returning({ id: apiKeys.id })
  if (!row) throw ApiError.notFound("key")
  return c.body(null, 204)
})
