import { z } from "zod"
import { paginationSchema, uuidSchema } from "./primitives.ts"

export const QR_PATTERNS = ["squares", "rounded", "dots"] as const
export type QrPattern = (typeof QR_PATTERNS)[number]

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a 6-digit hex color")

export const qrCodeCreateSchema = z.strictObject({
  linkId: uuidSchema, // required — a QR code is never free-floating
  name: z.string().trim().min(1).max(120).nullish(),
  dotColor: hexColor.default("#000000"),
  bgColor: hexColor.default("#ffffff"),
  pattern: z.enum(QR_PATTERNS).default("squares"),
})
export type QrCodeCreate = z.input<typeof qrCodeCreateSchema>

/** `linkId` is omitted, not just optional: re-pointing a QR at a different
 *  link would invalidate every printed copy, same reasoning that freezes a
 *  link's `slug`. */
export const qrCodePatchSchema = qrCodeCreateSchema.omit({ linkId: true }).partial()
export type QrCodePatch = z.infer<typeof qrCodePatchSchema>

export const qrCodeListQuerySchema = paginationSchema.extend({
  linkId: uuidSchema.optional(),
  search: z.string().trim().optional(),
})

export type QrCode = {
  id: string
  linkId: string
  name: string | null
  dotColor: string
  bgColor: string
  pattern: QrPattern

  // The link's, carried along so a list row renders without a second request.
  linkName: string | null
  linkStatus: "active" | "archived"
  /** The `api_keys.id` that owns the *link* (ADR 0011: the key is the
   *  principal). A QR code has no owner of its own — this only gates the
   *  client's row menu as a UI courtesy; the server never trusts it. See
   *  plans/Plan_31.md §A1 for why it is not spelled `ownerId` or `apiKeyId`. */
  linkOwnerId: string | null
  slug: string
  domainHost: string
  shortUrl: string

  createdAt: string
  updatedAt: string
}
