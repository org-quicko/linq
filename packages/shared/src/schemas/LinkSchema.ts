import { z } from "zod"
import { LINK_TYPES } from "../constants/index.ts"
import {
  csvList,
  paginationSchema,
  resourceStatusSchema,
  slugSchema,
  tagSchema,
  urlSchema,
  uuidSchema,
} from "./CommonSchema.ts"
import { rulesPutSchema } from "./RuleSchema.ts"

/**
 * Set on the destination at redirect time, overriding both the destination's
 * own query and anything forwarded. Applied only when the link forwards; one
 * value per key, so a repeated key is impossible by construction.
 */
export const presetParamsSchema = z
  .record(z.string().trim().min(1).max(64), z.string().max(512))
  .refine((p) => Object.keys(p).length <= 20, "at most 20 preset params")

/** Redirect Links by default, so a caller from before Link Trees sees the list
 *  it always did. `all` is for views that mix both types, like Archives. */
const linkTypeFilterSchema = z.enum([...LINK_TYPES, "all"]).default("redirect")

export const linkCreateSchema = z.object({
  domain_id: uuidSchema,
  /** Omit for a generated slug. */
  slug: slugSchema.optional(),
  destination: urlSchema,
  /** Omit to use the destination page's title, falling back to its host. */
  name: z.string().trim().max(200).optional(),
  /** Omit to have it filled from the destination's <head>. See resources/docs/adr/0014. */
  description: z.string().trim().max(500).optional(),
  tags: z.array(tagSchema).max(20).default([]),
  forward_query_params: z.boolean().default(true),
  preset_params: presetParamsSchema.default({}),
  /** ISO-8601. Absent or null means the link never expires. */
  expires_at: z.iso.datetime().nullable().optional(),
  /** Opt-in: appears in the domain's public /llms.txt catalogue. */
  listed: z.boolean().default(false),
  /** Ordered alternate destinations. */
  rules: rulesPutSchema.default([]),
})

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
    forward_query_params: z.boolean(),
    preset_params: presetParamsSchema,
    status: resourceStatusSchema,
    expires_at: z.iso.datetime().nullable(),
    listed: z.boolean(),
    rules: rulesPutSchema,
  })
  .partial()

export const linkListQuerySchema = paginationSchema.extend({
  search: z.string().trim().min(1).max(200).optional(),
  /** Comma-separated; a link matches when it carries any of them. */
  tags: csvList(tagSchema),
  /** Comma-separated; a link matches when its domain is any of them. Kept
   *  as `domain_id` rather than renamed to plural, so a caller passing a
   *  single uuid keeps working unchanged. */
  domain_id: csvList(uuidSchema),
  status: z.enum(["active", "archived", "all"]).default("active"),
  sort: z.enum(["created_at", "updated_at", "visits"]).default("created_at"),
  order: z.enum(["asc", "desc"]).default("desc"),
  expiry: z.enum(["any", "live", "expired"]).default("any"),
  type: linkTypeFilterSchema,
})

/** Just the `status` filter `linkListQuerySchema` also takes — a count has no
 *  page to sort or paginate, so those fields don't apply here. */
export const linkCountQuerySchema = z.object({
  status: z.enum(["active", "archived", "all"]).default("active"),
  type: linkTypeFilterSchema,
})
