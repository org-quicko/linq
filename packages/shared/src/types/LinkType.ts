import type { z } from "zod"
import type { linkCreateSchema, linkListQuerySchema, linkPatchSchema } from "../schemas/index.ts"

/** A link as the API returns it. */
export type Link = {
  id: string
  domain_id: string
  domain_host: string
  slug: string
  short_url: string
  destination: string
  name: string | null
  description: string | null
  icon_url: string | null
  tags: string[]
  forward_query: boolean
  preset_params: Record<string, string>
  status: "active" | "archived"
  human_visits: number
  bot_visits: number
  expires_at: string | null
  listed: boolean
  /** How many rules (alternate destinations) this link carries. Drives the
   *  "routes dynamically" treatment in the client's list row once it exceeds 1. */
  rule_count: number
  created_at: string
  updated_at: string
}

/** `GET /v1/links/count`'s response. */
export type LinkCount = { total: number }

/** `DELETE /v1/links/purge`'s response: how many archived links it destroyed. */
export type LinkPurgeResult = { purged: number }

/** A `POST /links` body before defaults are applied, as a client sends it. */
export type LinkCreate = z.input<typeof linkCreateSchema>

/** A validated `POST /links` body, defaults applied. */
export type LinkCreateInput = z.infer<typeof linkCreateSchema>

/** A validated `PATCH /links/:id` body. */
export type LinkPatch = z.infer<typeof linkPatchSchema>

/** A validated `GET /links` query. */
export type LinkListQuery = z.infer<typeof linkListQuerySchema>

/** A `links` row as the database returns it. */
export type LinkRow = {
  id: string
  domain_id: string
  slug: string
  destination: string
  name: string | null
  description: string | null
  icon_url: string | null
  forward_query: boolean
  preset_params: Record<string, string>
  status: "active" | "archived"
  expires_at: Date | null
  listed: boolean
  created_at: Date
  updated_at: Date
}

/** A `links` row with the joins and totals every link response carries. */
export type LinkJoinedRow = LinkRow & {
  domain_host: string
  human_visits: number
  bot_visits: number
  rule_count: number
  tags: string[]
}

/** The `links` columns a create sets; the caller adds `id`. */
export type LinkInsert = Omit<LinkRow, "id" | "status" | "created_at" | "updated_at">

/** The `links` columns a patch changes. */
export type LinkUpdate = Partial<Omit<LinkRow, "id" | "domain_id" | "slug" | "created_at">>
