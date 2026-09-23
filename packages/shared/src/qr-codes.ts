import { z } from "zod"
import { paginationSchema, uuidSchema } from "./primitives.ts"

export const QR_PATTERNS = ["squares", "rounded", "dots"] as const
export type QrPattern = (typeof QR_PATTERNS)[number]

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a 6-digit hex color")

export const qrCodeCreateSchema = z.strictObject({
  link_id: uuidSchema, // required — a QR code is never free-floating
  name: z.string().trim().min(1).max(120).nullish(),
  dot_color: hexColor.default("#000000"),
  bg_color: hexColor.default("#ffffff"),
  pattern: z.enum(QR_PATTERNS).default("squares"),
})
export type QrCodeCreate = z.input<typeof qrCodeCreateSchema>

/** `link_id` is omitted, not just optional: re-pointing a QR at a different
 *  link would invalidate every printed copy, same reasoning that freezes a
 *  link's `slug`. */
export const qrCodePatchSchema = qrCodeCreateSchema.omit({ link_id: true }).partial()
export type QrCodePatch = z.infer<typeof qrCodePatchSchema>

export const qrCodeListQuerySchema = paginationSchema.extend({
  link_id: uuidSchema.optional(),
  search: z.string().trim().optional(),
})

export type QrCode = {
  id: string
  link_id: string
  name: string | null
  dot_color: string
  bg_color: string
  pattern: QrPattern

  // The link's, carried along so a list row renders without a second request.
  link_name: string | null
  link_status: "active" | "archived"
  /** The `api_keys.id` that owns the *link* (ADR 0011: the key is the
   *  principal). A QR code has no owner of its own — this only gates the
   *  client's row menu as a UI courtesy; the server never trusts it. Named
   *  `link_owner_id` rather than `owner_id` or `apiKeyId` to make clear it's
   *  the link's owner, not the QR code's. */
  link_owner_id: string | null
  slug: string
  domain_host: string
  short_url: string

  created_at: string
  updated_at: string
}
