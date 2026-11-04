import { rulesPutSchema, uuidSchema } from "@linq/shared"
import { Hono } from "hono"
import { z } from "zod"
import type { Env } from "../http/env.ts"
import { validate } from "../http/validate.ts"
import { getLinkRules, replaceLinkRules } from "./service.ts"

const idParam = validate("param", z.object({ id: uuidSchema }))

/**
 * Mounted alongside linkRoutes on /links, so `/:id` there and `/:id/rules` here
 * stay in their own files without fighting over the prefix.
 */
export const ruleRoutes = new Hono<Env>()
  .get("/:id/rules", idParam, async (c) => c.json(await getLinkRules(c.var, c.req.valid("param").id)))

  .put("/:id/rules", idParam, validate("json", rulesPutSchema), async (c) =>
    c.json(await replaceLinkRules(c.var, c.var.principal, c.req.valid("param").id, c.req.valid("json"))),
  )
