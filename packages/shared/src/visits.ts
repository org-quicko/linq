import { z } from "zod"
import {
  type Browser,
  type Os,
  type Platform,
  paginationSchema,
  platformSchema,
  uuidSchema,
} from "./primitives.ts"

/** Narrows a read to one link, one domain, or the orphan slice. */
const scope = {
  link_id: uuidSchema.optional(),
  domain_id: uuidSchema.optional(),
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

export type Visit = {
  id: string
  link_id: string | null
  domain_id: string
  slug_requested: string
  occurred_at: string
  is_bot: boolean
  platform: Platform
  os: Os | null
  browser: Browser | null
  user_agent: string | null
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
