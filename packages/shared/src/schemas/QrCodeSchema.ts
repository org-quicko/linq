import { z } from "zod"
import { QR_PATTERNS } from "../constants/index.ts"
import { paginationSchema, uuidSchema } from "./CommonSchema.ts"

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a 6-digit hex color")

export const qrCodeCreateSchema = z.strictObject({
  link_id: uuidSchema, // required — a QR code is never free-floating
  name: z.string().trim().min(1).max(120).nullish(),
  dot_color: hexColor.default("#000000"),
  bg_color: hexColor.default("#ffffff"),
  pattern: z.enum(QR_PATTERNS).default("squares"),
})

/** `link_id` is omitted, not just optional: re-pointing a QR at a different
 *  link would invalidate every printed copy, same reasoning that freezes a
 *  link's `slug`. */
export const qrCodePatchSchema = qrCodeCreateSchema.omit({ link_id: true }).partial()

export const qrCodeListQuerySchema = paginationSchema.extend({
  link_id: uuidSchema.optional(),
  search: z.string().trim().optional(),
})
