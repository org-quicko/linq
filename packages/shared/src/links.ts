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
  domain_id: uuidSchema,
  /** Omit for a generated slug. */
  slug: slugSchema.optional(),
  destination: urlSchema,
  name: z.string().trim().max(200).optional(),
  /** Omit to have it filled from the destination's <head>. See docs/adr/0014. */
  description: z.string().trim().max(500).optional(),
  tags: z.array(tagSchema).max(20).default([]),
  forward_query: z.boolean().default(true),
  preset_params: presetParamsSchema.default({}),
  /** ISO-8601. Absent or null means the link never expires. */
  expires_at: z.iso.datetime().nullable().optional(),
  /** Opt-in: appears in the domain's public /llms.txt catalogue. */
  listed: z.boolean().default(false),
  /** Ordered alternate destinations. */
  rules: rulesPutSchema.default([]),
})
export type LinkCreate = z.input<typeof linkCreateSchema>

/**
 * `slug` and `domain_id` are immutable: changing them would break live links.
 * Strict, so sending either is a 400 rather than a silently ignored field.
 */
export const linkPatchSchema = z
  .strictObject({
    destination: urlSchema,
    name: z.string().trim().max(200).nullable(),
    description: z.string().trim().max(500).nullable(),
    tags: z.array(tagSchema).max(20),
    forward_query: z.boolean(),
    preset_params: presetParamsSchema,
    status: resourceStatusSchema,
    owner_id: uuidSchema,
    expires_at: z.iso.datetime().nullable(),
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
   *  as `domain_id` rather than renamed to plural, so a caller passing a
   *  single uuid keeps working unchanged. */
  domain_id: z
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
  owner_id: uuidSchema.optional(),
  status: z.enum(["active", "archived", "all"]).default("active"),
  sort: z.enum(["created_at", "updated_at", "visits"]).default("created_at"),
  order: z.enum(["asc", "desc"]).default("desc"),
  expiry: z.enum(["any", "live", "expired"]).default("any"),
})

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
  owner_id: string | null
  owner_name: string | null
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
