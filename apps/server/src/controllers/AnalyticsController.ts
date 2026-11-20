import {
  analyticsBreakdownQuerySchema,
  analyticsSummaryQuerySchema,
  analyticsTimeseriesQuerySchema,
} from "@linq/shared"
import type { Context } from "hono"
import { Log } from "../libs/index.ts"
import type { AnalyticsService } from "../services/index.ts"
import { RequestUtil } from "../utils/index.ts"

/** HTTP layer for `/analytics`: counts over the rollup or the raw log. */
export class AnalyticsController {
  /**
   * @param analyticsService - Rollup and raw-log reads.
   */
  constructor(private readonly analyticsService: AnalyticsService) {}

  /**
   * GET /analytics/summary
   * Total, human, bot and orphan visit counts for a scope.
   *
   * @param c - Hono request context; accepts the `analyticsSummaryQuerySchema` query params.
   * @returns JSON `{ visits, human, bot, orphans }`.
   * @throws {HttpError} 400 if the query does not validate.
   */
  @Log("analyticsController.summary")
  summary = async (c: Context) => {
    const q = await RequestUtil.parse(c, "query", analyticsSummaryQuerySchema)
    return c.json(await this.analyticsService.summary(q))
  }

  /**
   * GET /analytics/timeseries
   * Human and bot counts per day, week or month, oldest first.
   *
   * @param c - Hono request context; accepts the `analyticsTimeseriesQuerySchema` query params.
   * @returns JSON array of buckets.
   * @throws {HttpError} 400 if the query does not validate.
   */
  @Log("analyticsController.timeseries")
  timeseries = async (c: Context) => {
    const q = await RequestUtil.parse(c, "query", analyticsTimeseriesQuerySchema)
    return c.json(await this.analyticsService.timeseries(q))
  }

  /**
   * GET /analytics/breakdown
   * Human and bot counts grouped by one dimension, busiest first.
   *
   * @param c - Hono request context; accepts the `analyticsBreakdownQuerySchema` query params.
   * @returns JSON array of buckets.
   * @throws {HttpError} 400 if the query does not validate.
   */
  @Log("analyticsController.breakdown")
  breakdown = async (c: Context) => {
    const q = await RequestUtil.parse(c, "query", analyticsBreakdownQuerySchema)
    return c.json(await this.analyticsService.breakdown(q))
  }
}
