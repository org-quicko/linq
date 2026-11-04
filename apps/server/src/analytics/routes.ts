import {
  analyticsBreakdownQuerySchema,
  analyticsSummaryQuerySchema,
  analyticsTimeseriesQuerySchema,
} from "@linq/shared"
import { Hono } from "hono"
import type { Env } from "../app/env.ts"
import { validate } from "../app/validate.ts"
import { getBreakdown, getSummary, getTimeseries } from "./service.ts"

/** Mounted at /analytics. */
export const analyticsRoutes = new Hono<Env>()
  .get("/summary", validate("query", analyticsSummaryQuerySchema), async (c) =>
    c.json(await getSummary(c.var, c.req.valid("query"))),
  )
  .get("/timeseries", validate("query", analyticsTimeseriesQuerySchema), async (c) =>
    c.json(await getTimeseries(c.var, c.req.valid("query"))),
  )
  .get("/breakdown", validate("query", analyticsBreakdownQuerySchema), async (c) =>
    c.json(await getBreakdown(c.var, c.req.valid("query"))),
  )
