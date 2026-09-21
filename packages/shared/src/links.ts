import { z } from "zod"
import { paginationSchema, slugSchema, tagSchema, urlSchema, uuidSchema } from "./primitives.ts"
import { resourceStatusSchema } from "./roles.ts"
import { rulesPutSchema } from "./rules.ts"

/**
 * Set on the destination at redirect time, overriding both the destination's
 * own query and anything forwarded. Applied only when the link forwards; one
 * value per key, so a repeated key is impossible by construction.
 */
export const presetParamsSchema = z
  .record(z.string().trim().min(1).max(64), z.string().max(512))
  .refine((p) => Object.keys(p).length <= 20, "at most 20 preset params")

export const linkCreateSchema = z.object({
  domainId: uuidSchema,
  /** Omit for a generated slug. */
  slug: slugSchema.optional(),
  destination: urlSchema,
  name: z.string().trim().max(200).optional(),
  tags: z.array(tagSchema).max(20).default([]),
  forwardQuery: z.boolean().default(true),
  presetParams: presetParamsSchema.default({}),
  /** ISO-8601. Absent or null means the link never expires. */
  expiresAt: z.iso.datetime().nullable().optional(),
  /** Opt-in: appears in the domain's public /llms.txt catalogue. */
  listed: z.boolean().default(false),
  /** Ordered alternate destinations. */
  rules: rulesPutSchema.default([]),
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
    presetParams: presetParamsSchema,
    status: resourceStatusSchema,
    ownerId: uuidSchema,
    expiresAt: z.iso.datetime().nullable(),
    listed: z.boolean(),
    rules: rulesPutSchema,
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
  /** Comma-separated; a link matches when its domain is any of them. Kept
   *  as `domainId` rather than renamed to plural, so a caller passing a
   *  single uuid keeps working unchanged. */
  domainId: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter((s) => uuidSchema.safeParse(s).success)
        : [],
    ),
  ownerId: uuidSchema.optional(),
  status: z.enum(["active", "archived", "all"]).default("active"),
  sort: z.enum(["createdAt", "updatedAt", "visits"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  expiry: z.enum(["any", "live", "expired"]).default("any"),
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
  presetParams: Record<string, string>
  status: "active" | "archived"
  ownerId: string | null
  ownerName: string | null
  humanVisits: number
  botVisits: number
  expiresAt: string | null
  listed: boolean
  /** How many rules (alternate destinations) this link carries. Drives the
   *  "routes dynamically" treatment in the client's list row once it exceeds 1. */
  ruleCount: number
  createdAt: string
  updatedAt: string
}
