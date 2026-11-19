import type { Visit, VisitRow } from "@linq/shared"

/**
 * Maps a `visits` row to the JSON shape the API returns.
 *
 * @param row - A row from the `visits` table.
 * @returns The API `Visit`.
 */
export class VisitRowToVisitConverter {
  convertFrom(row: VisitRow): Visit {
    return {
      id: row.id,
      link_id: row.link_id,
      domain_id: row.domain_id,
      slug_requested: row.slug_requested,
      visited_at: row.visited_at.toISOString(),
      is_bot: row.is_bot,
      bot_classification_reason: row.bot_classification_reason,
      platform: row.platform,
      os: row.os,
      browser: row.browser,
      user_agent: row.user_agent,
      referer: row.referer,
      destination: row.destination,
      query_params: row.query_params,
    }
  }
}
