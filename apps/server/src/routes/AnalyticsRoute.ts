import { Hono } from "hono"
import { AnalyticsController } from "../controllers/index.ts"
import type { AnalyticsService } from "../services/index.ts"

/**
 * Builds the analytics routes, mounted on `/analytics`. Called once, by `createApp`.
 *
 * - GET /summary     - visit counts for a scope.
 * - GET /timeseries  - counts per period.
 * - GET /breakdown   - counts per value of one dimension.
 *
 * @param analyticsService - The app's one `AnalyticsService`.
 * @returns The `/analytics` sub-app.
 */
export function analyticsRoutes(analyticsService: AnalyticsService) {
  const analyticsController = new AnalyticsController(analyticsService)

  return new Hono()
    .get("/summary", analyticsController.summary)
    .get("/timeseries", analyticsController.timeseries)
    .get("/breakdown", analyticsController.breakdown)
}
