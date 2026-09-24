import { type Rule, rulesPutSchema, uuidSchema } from "@linq/shared"
import { Hono } from "hono"
import { z } from "zod"
import { assertCanEdit } from "../../auth/permissions.ts"
import { targetKey } from "../../cache.ts"
import type { Selectable } from "kysely"
import type { DB } from "../../db/types.generated.ts"
import { listRules } from "../../rules/store.ts"
import type { Env } from "../env.ts"
import { validate } from "../validate.ts"
import { loadLink } from "./links.ts"

const idParam = validate("param", z.object({ id: uuidSchema }))

/** Maps a rule row to the JSON shape the API returns. */
function toRule(row: Selectable<DB["rules"]>): Rule {
  return {
    id: row.id,
    link_id: row.link_id,
    position: row.position,
    destination: row.destination,
    conditions: row.conditions,
  }
}

/**
 * Mounted alongside linkRoutes on /links, so `/:id` there and `/:id/rules` here
 * stay in their own files without fighting over the prefix.
 */
export const ruleRoutes = new Hono<Env>()
  .get("/:id/rules", idParam, async (c) => {
    const { id } = c.req.valid("param")
    // Load first, so an unknown link is a 404 rather than an empty list.
    await loadLink(c.var.db, id)
    return c.json((await listRules(c.var.db, id)).map(toRule))
  })

  /** Replaces the whole ordered set; the server owns `position`. */
  .put("/:id/rules", idParam, validate("json", rulesPutSchema), async (c) => {
    const { id } = c.req.valid("param")
    const link = await loadLink(c.var.db, id)
    assertCanEdit(c.var.principal)
    const input = c.req.valid("json")

    // One transaction: a failed insert must never leave the link with its old
    // rules deleted and no new ones in their place.
    await c.var.db.transaction().execute(async (tx) => {
      await tx.deleteFrom("rules").where("link_id", "=", id).execute()
      if (input.length === 0) return
      await tx.insertInto("rules").values(
        input.map((rule, position) => ({
          id: Bun.randomUUIDv7(),
          link_id: id,
          position,
          destination: rule.destination,
          conditions: rule.conditions,
        })),
      ).execute()
    })

    // The redirect caches a link's rules inside its target entry, so replacing
    // them has to clear it just as editing the link itself does.
    await c.var.cache.del(targetKey(link.domain_id, link.slug))
    return c.json((await listRules(c.var.db, id)).map(toRule))
  })
