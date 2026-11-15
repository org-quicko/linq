import { rulesPutSchema } from "@linq/shared"
import { Hono } from "hono"
import { type Env, refreshCache, targetKey } from "../libs/index.ts"
import { authorize, idParam, validate } from "../middleware/index.ts"
import { findActiveTarget, listRules, loadLink, replaceRules, toRule } from "../services/index.ts"

/**
 * Mounted alongside `linkRoute` on /links, so `/:id` there and `/:id/rules`
 * here stay in their own files without fighting over the prefix.
 */
export const ruleRoute = new Hono<Env>()
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
    authorize(c.var.principal, "update", "Link")
    const rules = c.req.valid("json")
    await c.var.db.transaction().execute((tx) => replaceRules(tx, id, rules))
    // The redirect caches a link's rules inside its target entry, so replacing
    // them rewrites it just as editing the link itself does.
    await refreshCache(c.var.cache, targetKey(link.domain_id, link.slug), () =>
      findActiveTarget(c.var.db, link.domain_id, link.slug),
    )
    return c.json((await listRules(c.var.db, id)).map(toRule))
  })
