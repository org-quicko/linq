import type { DomainRow, ResolvedDomain } from "@linq/shared"

/**
 * Keeps only what the redirect needs from a domain row, which is also what gets cached.
 *
 * @param row - The active domain's row, or the columns of it the redirect selects.
 * @returns The cacheable `ResolvedDomain`.
 */
export class DomainRowToResolvedDomainConverter {
  convertFrom(
    row: Pick<
      DomainRow,
      "id" | "fallback_url" | "base_path_redirect" | "invalid_short_url_redirect"
    >,
  ): ResolvedDomain {
    return {
      id: row.id,
      fallback_url: row.fallback_url,
      base_path_redirect: row.base_path_redirect,
      invalid_short_url_redirect: row.invalid_short_url_redirect,
    }
  }
}
