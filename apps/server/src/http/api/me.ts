import { Hono } from "hono"
import type { Env } from "../env.ts"
import { toApiKey } from "./keys.ts"

/**
 * The calling key itself. The Client UI gates its menus on this, and its server
 * probe uses it to tell a linq instance from anything else that answers.
 */
export const meRoutes = new Hono<Env>().get("/", async (c) => {
  const row = await c.var.db
    .selectFrom("api_keys")
    .selectAll()
    .where("id", "=", c.var.principal.keyId)
    .limit(1)
    .executeTakeFirst()

  // The key authenticated moments ago, so its row cannot be missing without a
  // concurrent revoke; 404 says so rather than serialising undefined.
  if (!row) throw new Error("the calling key vanished mid-request")
  return c.json(toApiKey(row))
})
