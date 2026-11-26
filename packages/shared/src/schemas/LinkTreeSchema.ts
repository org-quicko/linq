import { z } from "zod"
import {
  LINK_TREE_APPEARANCES,
  LINK_TREE_BUTTON_STYLES,
  LINK_TREE_DEFAULT_ACCENT,
  LINK_TREE_MAX_ITEMS,
} from "../constants/index.ts"
import { slugSchema, tagSchema, urlSchema, uuidSchema } from "./CommonSchema.ts"

/** A six-digit hex colour, stored lowercase. */
export const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "must be a six-digit hex colour, e.g. #2563eb")
  .toLowerCase()

const itemLabelSchema = z.string().trim().min(1).max(100)

/**
 * One Item as a client sends it: either an existing Link on the tree's Domain,
 * or a URL that becomes a new short Link there. Strict, so an object carrying
 * both is a 400 rather than silently matching the first branch. Omitting
 * `label` uses the target Link's name.
 */
export const linkTreeItemInputSchema = z.union([
  z.strictObject({ label: itemLabelSchema.optional(), link_id: uuidSchema }),
  z.strictObject({ label: itemLabelSchema.optional(), url: urlSchema }),
])

const linkTreeFields = {
  /** The page title, and the Link's name everywhere else in linq. */
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(500),
  image_url: urlSchema,
  appearance: z.enum(LINK_TREE_APPEARANCES),
  accent: hexColorSchema,
  button_style: z.enum(LINK_TREE_BUTTON_STYLES),
  tags: z.array(tagSchema).max(20),
  /** The whole ordered Item list; the server owns `position`. */
  items: z.array(linkTreeItemInputSchema).max(LINK_TREE_MAX_ITEMS),
}

export const linkTreeCreateSchema = z.object({
  domain_id: uuidSchema,
  /** Omit for a generated slug. */
  slug: slugSchema.optional(),
  name: linkTreeFields.name,
  description: linkTreeFields.description.optional(),
  image_url: linkTreeFields.image_url.nullable().optional(),
  appearance: linkTreeFields.appearance.default("auto"),
  accent: linkTreeFields.accent.default(LINK_TREE_DEFAULT_ACCENT),
  button_style: linkTreeFields.button_style.default("filled"),
  tags: linkTreeFields.tags.default([]),
  items: linkTreeFields.items.default([]),
})

/**
 * `slug` and `domain_id` are immutable, as on any Link. Archiving and
 * restoring go through `PATCH /links/:id`, like every other Link.
 */
export const linkTreePatchSchema = z
  .strictObject({
    ...linkTreeFields,
    description: linkTreeFields.description.nullable(),
    image_url: linkTreeFields.image_url.nullable(),
  })
  .partial()
