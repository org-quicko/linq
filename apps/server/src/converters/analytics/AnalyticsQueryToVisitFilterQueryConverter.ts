import type { AnalyticsQuery, VisitFilterQuery } from "@linq/shared"

/**
 * Restates an analytics query as a raw-log filter query, for reads the rollup
 * cannot answer. The analytics `referer` filter is the log's `referer_host`.
 *
 * @param q - Any analytics query.
 * @returns The equivalent `visitFilters` input.
 */
export class AnalyticsQueryToVisitFilterQueryConverter {
  convertFrom(q: AnalyticsQuery): VisitFilterQuery {
    const { referer, ...rest } = q
    return { ...rest, referer_host: referer }
  }
}
