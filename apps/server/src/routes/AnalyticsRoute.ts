import {
  analyticsBreakdownQuerySchema,
  analyticsSummaryQuerySchema,
  analyticsTimeseriesQuerySchema,
} from "@linq/shared"
import { Hono } from "hono"
import type { Env } from "../libs/index.ts"
import { validate } from "../middleware/index.ts"
import { getBreakdown, getSummary, getTimeseries } from "../services/index.ts"

/** Mounted at /analytics. */
export const analyticsRoute = new Hono<Env>()
  .get("/summary", validate("query", analyticsSummaryQuerySchema), async (c) =>
    c.json(await getSummary(c.var.db, c.req.valid("query"))),
  )
  .get("/timeseries", validate("query", analyticsTimeseriesQuerySchema), async (c) =>
    c.json(await getTimeseries(c.var.db, c.req.valid("query"))),
  )
  .get("/breakdown", validate("query", analyticsBreakdownQuerySchema), async (c) =>
    c.json(await getBreakdown(c.var.db, c.req.valid("query"))),
  )
