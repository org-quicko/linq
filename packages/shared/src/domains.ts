import { z } from "zod"
import { hostSchema, urlSchema } from "./primitives.ts"
import { resourceStatusSchema } from "./roles.ts"

export const domainCreateSchema = z.object({
  host: hostSchema,
  /** Where an unmatched-but-well-formed slug goes. Absent means 404. */
  fallback_url: urlSchema.nullable().optional(),
  /** Where a bare `GET /` on this host goes. Absent falls back to `fallback_url`. */
  base_path_redirect: urlSchema.nullable().optional(),
  /** Where a malformed (not just unknown) slug goes. Absent falls back to `fallback_url`. */
  invalid_short_url_redirect: urlSchema.nullable().optional(),
})

export const domainPatchSchema = z
  .object({
    fallback_url: urlSchema.nullable(),
    base_path_redirect: urlSchema.nullable(),
    invalid_short_url_redirect: urlSchema.nullable(),
    status: resourceStatusSchema,
  })
  .partial()

export type Domain = {
  id: string
  host: string
  fallback_url: string | null
  base_path_redirect: string | null
  invalid_short_url_redirect: string | null
  status: "active" | "archived"
  link_count: number
  created_at: string
  updated_at: string
}
