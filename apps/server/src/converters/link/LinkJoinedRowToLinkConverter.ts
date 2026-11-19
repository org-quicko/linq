import type { Link, LinkJoinedRow } from "@linq/shared"
import { UrlUtil } from "../../utils/index.ts"

/**
 * Maps a joined link row to the JSON shape the API returns.
 *
 * @param row - A row from the link query, joins included.
 * @returns The API `Link`.
 */
export class LinkJoinedRowToLinkConverter {
  convertFrom(row: LinkJoinedRow): Link {
    return {
      id: row.id,
      domain_id: row.domain_id,
      domain_host: row.domain_host,
      slug: row.slug,
      short_url: UrlUtil.shortUrl(row.domain_host, row.slug),
      destination: row.destination,
      name: row.name,
      description: row.description,
      icon_url: row.icon_url,
      tags: row.tags,
      forward_query: row.forward_query,
      preset_params: row.preset_params,
      status: row.status,
      human_visits: row.human_visits,
      bot_visits: row.bot_visits,
      expires_at: row.expires_at?.toISOString() ?? null,
      listed: row.listed,
      rule_count: row.rule_count,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    }
  }
}
