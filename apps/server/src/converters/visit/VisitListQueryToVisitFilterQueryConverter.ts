import type { VisitFilterQuery, VisitListQuery } from "@linq/shared"

/**
 * Lifts the raw log's single-valued query filters to the lists `visitFilters` takes.
 *
 * @param q - The validated `GET /visits` query.
 * @returns The filter query, with every filter the endpoint does not offer left empty.
 */
export class VisitListQueryToVisitFilterQueryConverter {
  convertFrom(q: VisitListQuery): VisitFilterQuery {
    return {
      from: q.from,
      to: q.to,
      bot: q.bot,
      orphan: q.orphan,
      link_id: q.link_id ? [q.link_id] : [],
      domain_id: q.domain_id ? [q.domain_id] : [],
      platform: q.platform ? [q.platform] : [],
      os: q.os ? [q.os] : [],
      browser: q.browser ? [q.browser] : [],
      referer_host: [],
      utm_source: [],
      utm_medium: [],
      utm_campaign: [],
      utm_content: [],
      utm_term: [],
      device_type: [],
    }
  }
}
