import type { Domain, DomainJoinedRow } from "@linq/shared"

/**
 * Maps a domain row and its link count to the JSON shape the API returns.
 *
 * @param row - A `domains` row with its `link_count`.
 * @returns The API `Domain`.
 */
export class DomainJoinedRowToDomainConverter {
  convertFrom(row: DomainJoinedRow): Domain {
    return {
      id: row.id,
      host: row.host,
      fallback_url: row.fallback_url,
      base_path_redirect: row.base_path_redirect,
      invalid_short_url_redirect: row.invalid_short_url_redirect,
      status: row.status,
      link_count: row.link_count,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    }
  }
}
