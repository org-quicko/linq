import { z } from "zod"
import { hostSchema, urlSchema } from "./primitives.ts"
import { resourceStatusSchema } from "./roles.ts"

export const domainCreateSchema = z.object({
  host: hostSchema,
  /** Where an unmatched-but-well-formed slug goes. Absent means 404. */
  fallbackUrl: urlSchema.nullable().optional(),
  /** Where a bare `GET /` on this host goes. Absent falls back to `fallbackUrl`. */
  basePathRedirect: urlSchema.nullable().optional(),
  /** Where a malformed (not just unknown) slug goes. Absent falls back to `fallbackUrl`. */
  invalidShortUrlRedirect: urlSchema.nullable().optional(),
})

export const domainPatchSchema = z
  .object({
    fallbackUrl: urlSchema.nullable(),
    basePathRedirect: urlSchema.nullable(),
    invalidShortUrlRedirect: urlSchema.nullable(),
    status: resourceStatusSchema,
  })
  .partial()

export type Domain = {
  id: string
  host: string
  fallbackUrl: string | null
  basePathRedirect: string | null
  invalidShortUrlRedirect: string | null
  status: "active" | "archived"
  linkCount: number
  createdAt: string
  updatedAt: string
}
