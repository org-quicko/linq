import { z } from "zod"
import { hostSchema, urlSchema } from "./primitives.ts"
import { resourceStatusSchema } from "./roles.ts"

export const domainCreateSchema = z.object({
  host: hostSchema,
  /** Where orphan clicks on this domain go. Absent means 404. */
  fallbackUrl: urlSchema.nullable().optional(),
})

export const domainPatchSchema = z
  .object({
    fallbackUrl: urlSchema.nullable(),
    status: resourceStatusSchema,
  })
  .partial()

export type Domain = {
  id: string
  host: string
  fallbackUrl: string | null
  status: "active" | "archived"
  linkCount: number
  createdAt: string
  updatedAt: string
}
