import type { QrCodeCreateInput, QrCodeInsert } from "@linq/shared"

/**
 * Maps a create request to the `qr_codes` columns it sets; the caller adds `id`.
 *
 * @param input - The validated create body.
 * @returns The insert row, minus `id`.
 */
export class QrCodeCreateInputToQrCodeInsertConverter {
  convertFrom(input: QrCodeCreateInput): QrCodeInsert {
    return {
      link_id: input.link_id,
      name: input.name ?? null,
      dot_color: input.dot_color,
      bg_color: input.bg_color,
      pattern: input.pattern,
    }
  }
}
