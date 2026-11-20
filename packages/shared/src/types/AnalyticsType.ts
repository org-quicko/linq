import type { z } from "zod"
import type {
  ANALYTICS_DIMENSIONS,
  ANALYTICS_FILTERS,
  ANALYTICS_GRANULARITIES,
} from "../constants/index.ts"
import type {
  analyticsBreakdownQuerySchema,
  analyticsSummaryQuerySchema,
  analyticsTimeseriesQuerySchema,
} from "../schemas/index.ts"

/** What a breakdown groups by. */
export type AnalyticsDimension = (typeof ANALYTICS_DIMENSIONS)[number]

/** What a report can be narrowed by. */
export type AnalyticsFilter = (typeof ANALYTICS_FILTERS)[number]

/** How wide one timeseries bucket is. */
export type AnalyticsGranularity = (typeof ANALYTICS_GRANULARITIES)[number]

/** A validated `GET /analytics/summary` query. */
export type AnalyticsQuery = z.infer<typeof analyticsSummaryQuerySchema>

/** A validated `GET /analytics/timeseries` query. */
export type AnalyticsTimeseriesQuery = z.infer<typeof analyticsTimeseriesQuerySchema>

/** A validated `GET /analytics/breakdown` query. */
export type AnalyticsBreakdownQuery = z.infer<typeof analyticsBreakdownQuerySchema>

/** `GET /analytics/summary`'s response. */
export type AnalyticsSummary = {
  visits: number
  human: number
  bot: number
  orphans: number
}

/** One row of a grouped stats result, as the API returns it. */
export type StatsBucket = {
  key: string
  human: number
  bot: number
}

/**
 * One grouped count row as the database returns it. A `sum()` arrives as a
 * numeric string despite the declared type, which is why it is converted.
 */
export type StatsBucketRow = {
  key: string
  human: number
  bot: number
}
