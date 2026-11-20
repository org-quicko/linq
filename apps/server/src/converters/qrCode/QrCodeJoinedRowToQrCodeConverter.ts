import type { QrCode, QrCodeJoinedRow } from "@linq/shared"
import { UrlUtil } from "../../utils/index.ts"

/**
 * Maps a QR code row, joined to its link and domain, to the JSON shape the API returns.
 *
 * @param row - A joined QR code row.
 * @returns The API `QrCode`.
 */
export class QrCodeJoinedRowToQrCodeConverter {
  convertFrom(row: QrCodeJoinedRow): QrCode {
    return {
      id: row.id,
      link_id: row.link_id,
      name: row.name,
      dot_color: row.dot_color,
      bg_color: row.bg_color,
      pattern: row.pattern,
      link_name: row.link_name,
      link_status: row.link_status,
      slug: row.slug,
      domain_host: row.domain_host,
      short_url: UrlUtil.shortUrl(row.domain_host, row.slug),
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    }
  }
}
