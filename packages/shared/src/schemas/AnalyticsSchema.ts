import { z } from "zod"
import {
  ANALYTICS_DIMENSIONS,
  ANALYTICS_FILTERS,
  ANALYTICS_GRANULARITIES,
  MAX_RANGE_DAYS,
  NOT_RECORDED,
} from "../constants/index.ts"
import { csvList, platformSchema, uuidSchema } from "./CommonSchema.ts"

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
  utm_source: csvList(filterValue),
  utm_medium: csvList(filterValue),
  utm_campaign: csvList(filterValue),
  utm_content: csvList(filterValue),
  utm_term: csvList(filterValue),
  device_type: csvList(filterValue),
}

type WindowedQuery = {
  from?: string
  to: string
  referer: string[]
  os: string[]
  browser: string[]
  platform: string[]
  utm_source: string[]
  utm_medium: string[]
  utm_campaign: string[]
  utm_content: string[]
  utm_term: string[]
  device_type: string[]
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
export const analyticsTimeseriesQuerySchema = withWindowRules(
  z.object({ ...analyticsQueryShape, granularity: z.enum(ANALYTICS_GRANULARITIES).default("day") }),
)
export const analyticsBreakdownQuerySchema = withWindowRules(
  z.object({ ...analyticsQueryShape, dimension: z.enum(ANALYTICS_DIMENSIONS) }),
)
