import { z } from "zod"
import {
  type Browser,
  type Os,
  type Platform,
  paginationSchema,
  platformSchema,
  uuidSchema,
} from "./primitives.ts"

export const GROUP_BY = [
  "day",
  "platform",
  "os",
  "browser",
  "referer",
  "destination",
  /** The slug as requested. The only grouping that says anything about orphans. */
  "slug",
] as const
export type GroupBy = (typeof GROUP_BY)[number]

/** Narrows a read to one link, one domain, or the orphan slice. */
const scope = {
  linkId: uuidSchema.optional(),
  domainId: uuidSchema.optional(),
  /** Restrict to visits that resolved to no link. */
  orphan: z.enum(["true", "false"]).default("false"),
}

/** Open vocabulary (`os`/`browser` aren't a closed enum like `platform`), lowercased at the boundary so a filter matches regardless of how it's typed — the stored value is always lowercase. */
const openFilter = z.string().min(1).toLowerCase().optional()

/**
 * The raw log filters on instants, because that is what a visit row carries.
 * `to` is inclusive.
 */
export const visitListQuerySchema = paginationSchema.extend({
  ...scope,
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  /** "any" keeps bots and humans together. */
  bot: z.enum(["true", "false", "any"]).default("any"),
  platform: platformSchema.optional(),
  os: openFilter,
  browser: openFilter,
})

/**
 * Reports filter on whole UTC days, not instants: they are served from a
 * day-grained rollup, and a window that cut a day in half could not be answered
 * from it. Both ends are inclusive. See docs/adr/0007.
 */
export const statsQuerySchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  groupBy: z.enum(GROUP_BY).default("day"),
})

export const globalStatsQuerySchema = statsQuerySchema.extend({
  orphan: scope.orphan,
  domainId: scope.domainId,
})

export type Visit = {
  id: string
  linkId: string | null
  domainId: string
  slugRequested: string
  occurredAt: string
  isBot: boolean
  platform: Platform
  os: Os | null
  browser: Browser | null
  userAgent: string | null
  referer: string | null
  destination: string | null
  query: Record<string, string[]> | null
}

/** One row of a grouped stats result. */
export type StatsBucket = {
  key: string
  human: number
  bot: number
}
