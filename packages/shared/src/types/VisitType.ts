import type { z } from "zod"
import type { BOT_CLASSIFICATION_REASONS, NOT_RECORDED } from "../constants/index.ts"
import type { visitListQuerySchema } from "../schemas/index.ts"
import type { Browser, Os, Platform } from "./CommonType.ts"

/** How a newer visit was classified. `unknown` is not proof of a human. Null predates the field. */
export type BotClassificationReason = (typeof BOT_CLASSIFICATION_REASONS)[number]

/** A visit as the API returns it. */
export type Visit = {
  id: string
  link_id: string | null
  domain_id: string
  slug_requested: string
  visited_at: string
  is_bot: boolean
  bot_classification_reason: BotClassificationReason | null
  platform: Platform
  os: Os | null
  browser: Browser | null
  user_agent: string | null
  referer: string | null
  destination: string | null
  query_params: Record<string, string[]> | null
}

/** A validated `GET /visits` query. */
export type VisitListQuery = z.infer<typeof visitListQuerySchema>

/** A `visits` row as the database returns it. */
export type VisitRow = {
  id: string
  link_id: string | null
  domain_id: string
  slug_requested: string
  visited_at: Date
  is_bot: boolean
  bot_classification_reason: BotClassificationReason | null
  platform: Platform
  os: Os | null
  browser: Browser | null
  user_agent: string | null
  referer: string | null
  /** Derived by the database from `referer`. */
  referer_host: string | null
  destination: string | null
  query_params: Record<string, string[]> | null
  /** Derived by the database from `query_params`. */
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  utm_content: string | null
  utm_term: string | null
  /** Derived by the database from `user_agent`. */
  device_type: string | null
  country: string | null
  region: string | null
}

/**
 * One visit as the redirect hands it over: the `visits` columns a writer sets,
 * minus the generated id and click time.
 */
export type VisitInput = Pick<VisitRow, "domain_id" | "slug_requested" | "is_bot" | "platform"> &
  Partial<
    Pick<
      VisitRow,
      | "link_id"
      | "bot_classification_reason"
      | "os"
      | "browser"
      | "user_agent"
      | "referer"
      | "destination"
      | "query_params"
      | "country"
      | "region"
    >
  >

/** The `visits` row an insert writes. */
export type VisitInsert = VisitInput & Pick<VisitRow, "id" | "visited_at">

/** Every narrowing the raw log accepts. Multi-valued filters are OR-ed within themselves. */
export type VisitFilterQuery = {
  from?: string
  to?: string
  bot?: "true" | "false" | "any"
  link_id: string[]
  domain_id: string[]
  orphan?: "true" | "false"
  platform: (Platform | typeof NOT_RECORDED)[]
  os: string[]
  browser: string[]
  referer_host: string[]
  utm_source: string[]
  utm_medium: string[]
  utm_campaign: string[]
  utm_content: string[]
  utm_term: string[]
  device_type: string[]
}
