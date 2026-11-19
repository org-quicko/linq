import {
  ANALYTICS_FILTERS,
  type AnalyticsBreakdownQuery,
  type AnalyticsGranularity,
  type AnalyticsQuery,
  type AnalyticsSummary,
  type AnalyticsTimeseriesQuery,
  type StatsBucket,
} from "@linq/shared"
import { type RawBuilder, type SqlBool, sql } from "kysely"
import type { Db } from "../clients/index.ts"
import {
  AnalyticsQueryToVisitFilterQueryConverter,
  StatsBucketRowsToStatsBucketsConverter,
} from "../converters/index.ts"
import { Log } from "../libs/index.ts"
import { FilterUtil } from "../utils/index.ts"

/**
 * Analytics reads. Two sources answer every one: without a dimension filter the
 * pre-aggregated `visit_days` rollup does; a dimension filter needs columns the
 * rollup does not keep, so the raw `visits` log answers instead.
 */
export class AnalyticsService {
  private readonly analyticsQueryToVisitFilterQueryConverter: AnalyticsQueryToVisitFilterQueryConverter
  private readonly statsBucketRowsToStatsBucketsConverter: StatsBucketRowsToStatsBucketsConverter

  /**
   * The timeseries bucket key per granularity, on each read path: the UTC date
   * its period starts on. `date_trunc('week', …)` is ISO, so weeks start on
   * Monday. The rollup's `day` is cast to a plain `timestamp` first, so the
   * session time zone never shifts a bucket. Fixed fragments rather than a bound
   * parameter, because GROUP BY must repeat the SELECT expression exactly, and two
   * separately numbered parameters would not match.
   */
  private static readonly ROLLUP_BUCKET: Record<AnalyticsGranularity, RawBuilder<string>> = {
    day: sql<string>`to_char(day, 'YYYY-MM-DD')`,
    week: sql<string>`to_char(date_trunc('week', day::timestamp), 'YYYY-MM-DD')`,
    month: sql<string>`to_char(date_trunc('month', day::timestamp), 'YYYY-MM-DD')`,
  }
  private static readonly DETAIL_BUCKET: Record<AnalyticsGranularity, RawBuilder<string>> = {
    day: sql<string>`to_char(visited_at at time zone 'UTC', 'YYYY-MM-DD')`,
    week: sql<string>`to_char(date_trunc('week', visited_at at time zone 'UTC'), 'YYYY-MM-DD')`,
    month: sql<string>`to_char(date_trunc('month', visited_at at time zone 'UTC'), 'YYYY-MM-DD')`,
  }

  /** The bucket key each breakdown dimension groups the raw log by. */
  private static readonly DETAIL_KEY = {
    platform: sql<string>`platform::text`,
    os: sql<string>`coalesce(os, '')`,
    browser: sql<string>`coalesce(browser, '')`,
    referer: sql<string>`referer_host`,
    slug: sql<string>`slug_requested`,
    destination: sql<string>`coalesce(destination, '')`,
    utm_source: sql<string>`coalesce(utm_source, '')`,
    utm_medium: sql<string>`coalesce(utm_medium, '')`,
    utm_campaign: sql<string>`coalesce(utm_campaign, '')`,
    utm_content: sql<string>`coalesce(utm_content, '')`,
    utm_term: sql<string>`coalesce(utm_term, '')`,
    device_type: sql<string>`coalesce(device_type, '')`,
  } as const

  private static readonly HUMAN = sql<number>`count(*) filter (where not is_bot)`
  private static readonly BOT = sql<number>`count(*) filter (where is_bot)`
  private static readonly ROLLUP_HUMAN =
    sql<number>`coalesce(sum(count) filter (where not is_bot), 0)`
  private static readonly ROLLUP_BOT = sql<number>`coalesce(sum(count) filter (where is_bot), 0)`

  /**
   * @param db - The database.
   */
  constructor(private readonly db: Db) {
    this.analyticsQueryToVisitFilterQueryConverter = new AnalyticsQueryToVisitFilterQueryConverter()
    this.statsBucketRowsToStatsBucketsConverter = new StatsBucketRowsToStatsBucketsConverter()
  }

  /**
   * Total, human, bot and orphan visit counts for the query's scope.
   *
   * @param q - The scope and filters to count over.
   * @returns The summary counts.
   */
  @Log("analytics.summary", {
    in: (q: AnalyticsQuery) => ({ source: AnalyticsService.needsDetail(q) ? "detail" : "rollup" }),
  })
  async summary(q: AnalyticsQuery): Promise<AnalyticsSummary> {
    const detail = AnalyticsService.needsDetail(q)

    // A link-scoped read has no orphans by definition, so it skips that query.
    let humanCount: number
    let botCount: number
    let orphans = 0
    if (detail) {
      const filters = FilterUtil.visitFilters(
        this.analyticsQueryToVisitFilterQueryConverter.convertFrom(q),
      )
      const row = await this.db
        .selectFrom("visits")
        .select([AnalyticsService.HUMAN.as("human"), AnalyticsService.BOT.as("bot")])
        .where((eb) => eb.and(filters))
        .executeTakeFirstOrThrow()
      humanCount = Number(row.human)
      botCount = Number(row.bot)
      if (!q.link_id.length) {
        const orphanRow = await this.db
          .selectFrom("visits")
          .select((eb) => eb.fn.countAll<number>().as("total"))
          .where((eb) => eb.and([...filters, sql<SqlBool>`link_id is null`]))
          .executeTakeFirstOrThrow()
        orphans = Number(orphanRow.total)
      }
    } else {
      const scope = [sql<SqlBool>`dimension = 'total'`, ...AnalyticsService.rollupScope(q)]
      const row = await this.db
        .selectFrom("visit_days")
        .select([AnalyticsService.ROLLUP_HUMAN.as("human"), AnalyticsService.ROLLUP_BOT.as("bot")])
        .where((eb) => eb.and(scope))
        .executeTakeFirstOrThrow()
      humanCount = Number(row.human)
      botCount = Number(row.bot)
      if (!q.link_id.length) {
        const orphanRow = await this.db
          .selectFrom("visit_days")
          .select(sql<number>`coalesce(sum(count), 0)`.as("total"))
          .where((eb) => eb.and([...scope, sql<SqlBool>`link_id is null`]))
          .executeTakeFirstOrThrow()
        orphans = Number(orphanRow.total)
      }
    }
    return { visits: humanCount + botCount, human: humanCount, bot: botCount, orphans }
  }

  /**
   * Human and bot counts per period, oldest first.
   *
   * @param q - The scope, filters and granularity.
   * @returns One bucket per period that has visits, keyed by its UTC start date.
   */
  @Log("analytics.timeseries", {
    in: (q: AnalyticsTimeseriesQuery) => ({
      source: AnalyticsService.needsDetail(q) ? "detail" : "rollup",
      granularity: q.granularity,
    }),
  })
  async timeseries(q: AnalyticsTimeseriesQuery): Promise<StatsBucket[]> {
    const detail = AnalyticsService.needsDetail(q)

    if (!detail) {
      const key = AnalyticsService.ROLLUP_BUCKET[q.granularity]
      return this.statsBucketRowsToStatsBucketsConverter.convertFrom(
        await this.db
          .selectFrom("visit_days")
          .select([
            key.as("key"),
            AnalyticsService.ROLLUP_HUMAN.as("human"),
            AnalyticsService.ROLLUP_BOT.as("bot"),
          ])
          .where("dimension", "=", "total")
          .where((eb) => eb.and(AnalyticsService.rollupScope(q)))
          .groupBy(key)
          .orderBy(key, "asc")
          .execute(),
      )
    }
    const key = AnalyticsService.DETAIL_BUCKET[q.granularity]
    return this.statsBucketRowsToStatsBucketsConverter.convertFrom(
      await this.db
        .selectFrom("visits")
        .select([key.as("key"), AnalyticsService.HUMAN.as("human"), AnalyticsService.BOT.as("bot")])
        .where((eb) =>
          eb.and(
            FilterUtil.visitFilters(this.analyticsQueryToVisitFilterQueryConverter.convertFrom(q)),
          ),
        )
        .groupBy(key)
        .orderBy(key, "asc")
        .execute(),
    )
  }

  /**
   * Human and bot counts grouped by one dimension, busiest first.
   *
   * @param q - The scope, filters and dimension.
   * @returns One bucket per value of the dimension.
   */
  @Log("analytics.breakdown", {
    in: (q: AnalyticsBreakdownQuery) => ({
      source: AnalyticsService.needsDetail(q) ? "detail" : "rollup",
    }),
  })
  async breakdown(q: AnalyticsBreakdownQuery): Promise<StatsBucket[]> {
    const detail = AnalyticsService.needsDetail(q)

    if (!detail) {
      const key = sql<string>`${sql.ref("value")}`
      return this.statsBucketRowsToStatsBucketsConverter.convertFrom(
        await this.db
          .selectFrom("visit_days")
          .select([
            key.as("key"),
            AnalyticsService.ROLLUP_HUMAN.as("human"),
            AnalyticsService.ROLLUP_BOT.as("bot"),
          ])
          .where("dimension", "=", q.dimension)
          .where((eb) => eb.and(AnalyticsService.rollupScope(q)))
          .groupBy(key)
          .orderBy(sql<number>`sum(count)`, "desc")
          .execute(),
      )
    }
    const key = AnalyticsService.DETAIL_KEY[q.dimension]
    return this.statsBucketRowsToStatsBucketsConverter.convertFrom(
      await this.db
        .selectFrom("visits")
        .select([key.as("key"), AnalyticsService.HUMAN.as("human"), AnalyticsService.BOT.as("bot")])
        .where((eb) =>
          eb.and(
            FilterUtil.visitFilters(this.analyticsQueryToVisitFilterQueryConverter.convertFrom(q)),
          ),
        )
        .groupBy(key)
        .orderBy(sql<number>`count(*)`, "desc")
        .orderBy(key, "asc")
        .execute(),
    )
  }

  /**
   * Whether any dimension filter is set, which is what forces a raw-log read.
   *
   * @param q - The query's dimension filters.
   * @returns True when the raw log must answer.
   */
  private static needsDetail(q: Pick<AnalyticsQuery, (typeof ANALYTICS_FILTERS)[number]>): boolean {
    return ANALYTICS_FILTERS.some((filter) => q[filter].length > 0)
  }

  /**
   * The scope filters the rollup can apply: its days, links, domains, orphans and bot split.
   *
   * @param q - The query.
   * @returns The predicates, to AND together.
   */
  private static rollupScope(q: AnalyticsQuery): RawBuilder<SqlBool>[] {
    const scope: RawBuilder<SqlBool>[] = []
    if (q.from) scope.push(sql<SqlBool>`day >= ${q.from}`)
    if (q.to) scope.push(sql<SqlBool>`day <= ${q.to}`)
    if (q.link_id.length) scope.push(sql<SqlBool>`link_id in (${sql.join(q.link_id)})`)
    if (q.domain_id.length) scope.push(sql<SqlBool>`domain_id in (${sql.join(q.domain_id)})`)
    if (q.orphan === "true") scope.push(sql<SqlBool>`link_id is null`)
    if (q.bot !== "any") scope.push(sql<SqlBool>`is_bot = ${q.bot === "true"}`)
    return scope
  }
}
