import type { z } from "zod"
import type { QR_PATTERNS } from "../constants/index.ts"
import type {
  qrCodeCreateSchema,
  qrCodeListQuerySchema,
  qrCodePatchSchema,
} from "../schemas/index.ts"

/** The module shapes a QR code can be drawn with. */
export type QrPattern = (typeof QR_PATTERNS)[number]

/** A QR code as the API returns it. */
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
  slug: string
  domain_host: string
  short_url: string

  created_at: string
  updated_at: string
}

/** A `POST /qr-codes` body before defaults are applied, as a client sends it. */
export type QrCodeCreate = z.input<typeof qrCodeCreateSchema>

/** A validated `POST /qr-codes` body, defaults applied. */
export type QrCodeCreateInput = z.infer<typeof qrCodeCreateSchema>

/** A validated `PATCH /qr-codes/:id` body. */
export type QrCodePatch = z.infer<typeof qrCodePatchSchema>

/** A validated `GET /qr-codes` query. */
export type QrCodeListQuery = z.infer<typeof qrCodeListQuerySchema>

/** A `qr_codes` row as the database returns it. */
export type QrCodeRow = {
  id: string
  link_id: string
  name: string | null
  dot_color: string
  bg_color: string
  pattern: QrPattern
  created_at: Date
  updated_at: Date
}

/** A `qr_codes` row joined to its link's name, status and slug and its domain's host. */
export type QrCodeJoinedRow = QrCodeRow & {
  link_name: string | null
  link_status: "active" | "archived"
  slug: string
  domain_host: string
}

/** The `qr_codes` columns a create sets; the caller adds `id`. */
export type QrCodeInsert = Pick<
  QrCodeRow,
  "link_id" | "name" | "dot_color" | "bg_color" | "pattern"
>
