import { z } from "zod"
import { paginationSchema, uuidSchema } from "./primitives.ts"

export const GROUP_BY = [
  "day",
  "country",
  "region",
  "platform",
  "referer",
  "destination",
  /** The slug as requested. The only grouping that says anything about orphans. */
  "slug",
] as const
export type GroupBy = (typeof GROUP_BY)[number]

const dateRange = {
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
}

export const clickListQuerySchema = paginationSchema.extend({
  ...dateRange,
  /** "any" keeps bots and humans together. */
  bot: z.enum(["true", "false", "any"]).default("any"),
})

export const statsQuerySchema = z.object({
  ...dateRange,
  groupBy: z.enum(GROUP_BY).default("day"),
})

export const globalStatsQuerySchema = statsQuerySchema.extend({
  /** Restrict to clicks that resolved to no linq. */
  orphan: z.enum(["true", "false"]).default("false"),
  domainId: uuidSchema.optional(),
})

export type Click = {
  id: string
  linqId: string | null
  domainId: string
  slugRequested: string
  occurredAt: string
  isBot: boolean
  platform: "android" | "ios" | "desktop"
  userAgent: string | null
  referer: string | null
  country: string | null
  region: string | null
  destination: string | null
  query: Record<string, string[]> | null
}

/** One row of a grouped stats result. */
export type StatsBucket = {
  key: string
  human: number
  bot: number
}
