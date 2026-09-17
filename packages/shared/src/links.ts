import { z } from "zod"
import { paginationSchema, slugSchema, tagSchema, urlSchema, uuidSchema } from "./primitives.ts"
import { resourceStatusSchema } from "./roles.ts"

export const linkCreateSchema = z.object({
  domainId: uuidSchema,
  /** Omit for a generated slug. */
  slug: slugSchema.optional(),
  destination: urlSchema,
  name: z.string().trim().max(200).optional(),
  tags: z.array(tagSchema).max(20).default([]),
  forwardQuery: z.boolean().default(true),
})
export type LinkCreate = z.input<typeof linkCreateSchema>

/**
 * `slug` and `domainId` are immutable: changing them would break live links.
 * Strict, so sending either is a 400 rather than a silently ignored field.
 */
export const linkPatchSchema = z
  .strictObject({
    destination: urlSchema,
    name: z.string().trim().max(200).nullable(),
    tags: z.array(tagSchema).max(20),
    forwardQuery: z.boolean(),
    status: resourceStatusSchema,
    ownerId: uuidSchema,
  })
  .partial()
export type LinkPatch = z.infer<typeof linkPatchSchema>

export const linkListQuerySchema = paginationSchema.extend({
  search: z.string().trim().min(1).max(200).optional(),
  /** Comma-separated; a link matches when it carries any of them. */
  tags: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean)
        : [],
    ),
  domainId: uuidSchema.optional(),
  ownerId: uuidSchema.optional(),
  status: z.enum(["active", "archived", "all"]).default("active"),
  sort: z.enum(["createdAt", "visits"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
})

export type Link = {
  id: string
  domainId: string
  domainHost: string
  slug: string
  shortUrl: string
  destination: string
  name: string | null
  tags: string[]
  forwardQuery: boolean
  status: "active" | "archived"
  ownerId: string
  ownerName: string | null
  humanVisits: number
  botVisits: number
  createdAt: string
  updatedAt: string
}
