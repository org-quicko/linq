import {
  type LinkListQuery,
  NOT_RECORDED,
  type Platform,
  type QrCodeListQuery,
  type VisitFilterQuery,
} from "@linq/shared"
import { type RawBuilder, type SqlBool, sql } from "kysely"
import { DateTimeUtil } from "./DateTimeUtil.ts"

/** List filters as SQL predicates, for links, QR codes and the raw visit log. */
export class FilterUtil {
  /**
   * The link list's filters, as predicates over `links` columns only, so the page
   * query (which joins) and the count query (which does not) share them. Expiry
   * uses the app clock, so the list agrees with the redirect on what "expired"
   * means.
   *
   * @param q - The validated list query.
   * @returns The predicates to AND together; empty for no filtering.
   */
  static linkFilters(q: LinkListQuery): RawBuilder<SqlBool>[] {
    const filters: RawBuilder<SqlBool>[] = []
    if (q.status !== "all") filters.push(sql<SqlBool>`links.status = ${q.status}`)
    if (q.type !== "all") filters.push(sql<SqlBool>`links.type = ${q.type}`)
    if (q.domain_id.length)
      filters.push(sql<SqlBool>`links.domain_id in (${sql.join(q.domain_id)})`)
    if (q.tags.length) {
      // A subquery, not a join, so the count query stays join-free.
      filters.push(sql<SqlBool>`exists (
      select 1 from link_tags join tags on tags.id = link_tags.tag_id
      where link_tags.link_id = links.id and tags.name = any(${sql.val(q.tags)}::text[])
    )`)
    }
    if (q.search) {
      const term = `%${q.search}%`
      filters.push(
        sql<SqlBool>`(links.slug ilike ${term} or links.name ilike ${term} or links.destination ilike ${term})`,
      )
    }
    if (q.expiry !== "any") {
      const now = new Date()
      filters.push(
        q.expiry === "expired"
          ? sql<SqlBool>`(links.expires_at is not null and links.expires_at <= ${now})`
          : sql<SqlBool>`(links.expires_at is null or links.expires_at > ${now})`,
      )
    }
    return filters
  }

  /**
   * The QR code list's filters. `search` reads link columns, so whichever query
   * uses these must join `links`.
   *
   * @param q - The validated list query.
   * @returns The predicates to AND together; empty for no filtering.
   */
  static qrCodeFilters(q: QrCodeListQuery): RawBuilder<SqlBool>[] {
    const filters: RawBuilder<SqlBool>[] = []
    if (q.link_id) filters.push(sql<SqlBool>`qr_codes.link_id = ${q.link_id}`)
    if (q.search) {
      const term = `%${q.search}%`
      filters.push(
        sql<SqlBool>`(qr_codes.name ilike ${term} or links.name ilike ${term} or links.slug ilike ${term})`,
      )
    }
    return filters
  }

  /**
   * Everything that narrows the raw log. Each predicate is parameterized by
   * Kysely; the unqualified column references are safe because callers select
   * from `visits` alone.
   *
   * @param q - Every narrowing the caller asked for.
   * @returns The predicates, ready to AND together.
   */
  static visitFilters(q: VisitFilterQuery): RawBuilder<SqlBool>[] {
    const filters: RawBuilder<SqlBool>[] = []
    if (q.from) filters.push(sql<SqlBool>`visited_at >= ${DateTimeUtil.startOfBound(q.from)}`)
    if (q.to) {
      // A bare date ends at the next UTC midnight; a date-time is inclusive.
      filters.push(
        q.to.includes("T")
          ? sql<SqlBool>`visited_at <= ${new Date(q.to)}`
          : sql<SqlBool>`visited_at < ${DateTimeUtil.nextUtcMidnight(q.to)}`,
      )
    }
    if (q.bot && q.bot !== "any") filters.push(sql<SqlBool>`is_bot = ${q.bot === "true"}`)
    if (q.link_id.length) filters.push(sql<SqlBool>`link_id in (${sql.join(q.link_id)})`)
    if (q.domain_id.length) filters.push(sql<SqlBool>`domain_id in (${sql.join(q.domain_id)})`)
    if (q.orphan === "true") filters.push(sql<SqlBool>`link_id is null`)
    if (q.platform.length) {
      const named = q.platform.filter((platform): platform is Platform => platform !== NOT_RECORDED)
      filters.push(
        named.length ? sql<SqlBool>`platform in (${sql.join(named)})` : sql<SqlBool>`false`,
      )
    }
    for (const column of FilterUtil.OPEN_DIMENSIONS) {
      const values = q[column]
      if (!values.length) continue
      const named = values.filter((value) => value !== "")
      const ref = sql.ref(column)
      if (!named.length) filters.push(sql<SqlBool>`${ref} is null`)
      else if (named.length === values.length)
        filters.push(sql<SqlBool>`${ref} in (${sql.join(named)})`)
      else filters.push(sql<SqlBool>`(${ref} in (${sql.join(named)}) or ${ref} is null)`)
    }
    if (q.referer_host.length)
      filters.push(sql<SqlBool>`referer_host in (${sql.join(q.referer_host)})`)
    return filters
  }

  /** Open-vocabulary columns, where `""` on the wire stands for "never recorded". */
  private static readonly OPEN_DIMENSIONS = [
    "os",
    "browser",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    "device_type",
  ] as const
}
