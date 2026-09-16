import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { apiKeys, users } from "../../db/schema.ts"
import type { Env } from "../env.ts"

/** Identity of the calling key. The Client UI gates its menus on this. */
export const meRoutes = new Hono<Env>().get("/", async (c) => {
  const { userId, keyId } = c.var.principal

  const [user] = await c.var.db
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  const [key] = await c.var.db
    .select({ prefix: apiKeys.prefix })
    .from(apiKeys)
    .where(eq(apiKeys.id, keyId))
    .limit(1)

  return c.json({ user, keyPrefix: key?.prefix ?? null })
})
