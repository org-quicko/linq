import { visitListQuerySchema } from "@linq/shared"
import { Hono } from "hono"
import type { Env } from "../http/env.ts"
import { validate } from "../http/validate.ts"
import { listVisits } from "./service.ts"

/** Mounted at /visits; the raw log, newest first. */
export const visitRoutes = new Hono<Env>().get("/", validate("query", visitListQuerySchema), async (c) =>
  c.json(await listVisits(c.var, c.req.valid("query"))),
)
