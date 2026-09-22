import { z } from "zod"
import { csvList, platformSchema, uuidSchema } from "./primitives.ts"

/** What a breakdown groups by. `day` is not here: it is its own endpoint,
 *  the only one that comes back chronologically and the only one a chart
 *  plots. */
export const ANALYTICS_DIMENSIONS = [
  "referer",
  "os",
  "browser",
  "platform",
  "slug",
  "destination",
] as const
export type AnalyticsDimension = (typeof ANALYTICS_DIMENSIONS)[number]

/** What a report can be narrowed by — a subset. Every one of these forces
 *  the read off the rollup (docs/adr/0015), which is why the set is
 *  deliberately smaller than the dimensions. */
export const ANALYTICS_FILTERS = ["referer", "os", "browser", "platform"] as const
export type AnalyticsFilter = (typeof ANALYTICS_FILTERS)[number]

/** The rollup stores '' where a dimension was never recorded — an absent
 *  referer, an OS the parser could not name. '' cannot survive a CSV round
 *  trip, so this is its wire spelling. Not a possible host, OS or browser
 *  name, so it cannot collide. */
export const NOT_RECORDED = "(none)"

/** One year. Enforced only where it bites: a window over the rollup is what
 *  the rollup is for; a window over the visit log is the scan a filtered
 *  report has to run — bounded so it stays cheap. */
export const MAX_RANGE_DAYS = 366

const filterValue = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => (v === NOT_RECORDED ? "" : v))

/** A plain object, not a `z.object()`, so `breakdown` can extend it with
 *  `dimension` before the shared window/filter refinements are applied —
 *  `.refine()` yields a schema that can no longer be `.extend()`ed. */
export const analyticsQueryShape = {
  /** Absent means all time, which is only allowed on the rollup path. */
  from: z.iso.date().optional(),
  to: z.iso.date().default(() => new Date().toISOString().slice(0, 10)),
  link_id: csvList(uuidSchema),
  domain_id: csvList(uuidSchema),
  orphan: z.enum(["true", "false"]).default("false"),
  bot: z.enum(["true", "false", "any"]).default("any"),
  referer: csvList(filterValue),
  os: csvList(filterValue),
  browser: csvList(filterValue),
  platform: csvList(z.union([platformSchema, z.literal(NOT_RECORDED)])),
}

type WindowedQuery = {
  from?: string
  to: string
  referer: string[]
  os: string[]
  browser: string[]
  platform: string[]
}

function hasDimensionFilter(q: WindowedQuery): boolean {
  return ANALYTICS_FILTERS.some((f) => q[f].length > 0)
}

/** The two rules every analytics query obeys, applied after the shape is
 *  whatever it needs to be for that endpoint. */
function withWindowRules<T extends WindowedQuery>(schema: z.ZodType<T>) {
  return schema
    .refine((q) => q.from === undefined || q.from <= q.to, {
      message: "from must be on or before to",
      path: ["to"],
    })
    .refine(
      (q) => {
        if (!hasDimensionFilter(q)) return true
        if (q.from === undefined) return false
        const days =
          (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86_400_000
        return days <= MAX_RANGE_DAYS
      },
      {
        message: `a dimension filter requires \`from\`, within ${MAX_RANGE_DAYS} days of \`to\``,
        path: ["from"],
      },
    )
}

export const analyticsSummaryQuerySchema = withWindowRules(z.object(analyticsQueryShape))
export const analyticsTimeseriesQuerySchema = withWindowRules(z.object(analyticsQueryShape))
export const analyticsBreakdownQuerySchema = withWindowRules(
  z.object({ ...analyticsQueryShape, dimension: z.enum(ANALYTICS_DIMENSIONS) }),
)

export type AnalyticsQuery = z.infer<typeof analyticsSummaryQuerySchema>
export type AnalyticsBreakdownQuery = z.infer<typeof analyticsBreakdownQuerySchema>

export type AnalyticsSummary = {
  visits: number
  human: number
  bot: number
  orphans: number
}
