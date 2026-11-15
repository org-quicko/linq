import {
  ANALYTICS_FILTERS,
  type AnalyticsBreakdownQuery,
  type AnalyticsDimension,
  type AnalyticsQuery,
  type AnalyticsSummary,
  type StatsBucket,
} from "@linq/shared"
import { type SqlBool, sql } from "kysely"
import { type Db, span } from "../libs/index.ts"
import { type VisitFilter, visitFilters } from "./VisitService.ts"

/**
 * Two sources answer every analytics read. Without a dimension filter the
 * pre-aggregated `visit_days` rollup does; a dimension filter needs columns the
 * rollup does not keep, so the raw `visits` log answers instead.
 */

/** The bucket key each breakdown dimension groups the raw log by. */
const DETAIL_KEY = {
  day: sql<string>`to_char(visited_at at time zone 'UTC', 'YYYY-MM-DD')`,
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

const human = sql<number>`count(*) filter (where not is_bot)`
const bot = sql<number>`count(*) filter (where is_bot)`
const rollupHuman = sql<number>`coalesce(sum(count) filter (where not is_bot), 0)`
const rollupBot = sql<number>`coalesce(sum(count) filter (where is_bot), 0)`

/** `sum()` comes back as a numeric string; the API promises numbers. */
const toBuckets = (rows: { key: string; human: number; bot: number }[]): StatsBucket[] =>
  rows.map((row) => ({ ...row, human: Number(row.human), bot: Number(row.bot) }))

/** Whether any dimension filter is set, which is what forces a raw-log read. */
function needsDetail(q: Pick<AnalyticsQuery, (typeof ANALYTICS_FILTERS)[number]>): boolean {
  return ANALYTICS_FILTERS.some((filter) => q[filter].length > 0)
}

/** The scope filters the rollup can apply: its days, links, domains, orphans and bot split. */
function rollupScope(q: AnalyticsQuery): VisitFilter[] {
  const scope: VisitFilter[] = []
  if (q.from) scope.push(sql<SqlBool>`day >= ${q.from}`)
  if (q.to) scope.push(sql<SqlBool>`day <= ${q.to}`)
  if (q.link_id.length) scope.push(sql<SqlBool>`link_id in (${sql.join(q.link_id)})`)
  if (q.domain_id.length) scope.push(sql<SqlBool>`domain_id in (${sql.join(q.domain_id)})`)
  if (q.orphan === "true") scope.push(sql<SqlBool>`link_id is null`)
  if (q.bot !== "any") scope.push(sql<SqlBool>`is_bot = ${q.bot === "true"}`)
  return scope
}

/** The same query, against the raw log. The analytics `referer` filter is the log's `referer_host`. */
function detailFilters(q: AnalyticsQuery): VisitFilter[] {
  const { referer, ...rest } = q
  return visitFilters({ ...rest, referer_host: referer })
}

function aggregateRollup(
  db: Db,
  scope: VisitFilter[],
  dimension: AnalyticsDimension | "day",
): Promise<StatsBucket[]> {
  const key =
    dimension === "day" ? sql<string>`to_char(day, 'YYYY-MM-DD')` : sql<string>`${sql.ref("value")}`
  return db
    .selectFrom("visit_days")
    .select([key.as("key"), rollupHuman.as("human"), rollupBot.as("bot")])
    .where("dimension", "=", dimension === "day" ? "total" : dimension)
    .where((eb) => eb.and(scope))
    .groupBy(key)
    .orderBy(
      dimension === "day" ? key : sql<number>`sum(count)`,
      dimension === "day" ? "asc" : "desc",
    )
    .execute()
    .then(toBuckets)
}

export function getSummary(db: Db, q: AnalyticsQuery): Promise<AnalyticsSummary> {
  const detail = needsDetail(q)
  return span(
    "analytics.summary",
    async () => {
      // A link-scoped read has no orphans by definition, so it skips that query.
      let humanCount: number
      let botCount: number
      let orphans = 0
      if (detail) {
        const filters = detailFilters(q)
        const row = await db
          .selectFrom("visits")
          .select([human.as("human"), bot.as("bot")])
          .where((eb) => eb.and(filters))
          .executeTakeFirstOrThrow()
        humanCount = Number(row.human)
        botCount = Number(row.bot)
        if (!q.link_id.length) {
          const orphanRow = await db
            .selectFrom("visits")
            .select((eb) => eb.fn.countAll<number>().as("total"))
            .where((eb) => eb.and([...filters, sql<SqlBool>`link_id is null`]))
            .executeTakeFirstOrThrow()
          orphans = Number(orphanRow.total)
        }
      } else {
        const scope = [sql<SqlBool>`dimension = 'total'`, ...rollupScope(q)]
        const row = await db
          .selectFrom("visit_days")
          .select([rollupHuman.as("human"), rollupBot.as("bot")])
          .where((eb) => eb.and(scope))
          .executeTakeFirstOrThrow()
        humanCount = Number(row.human)
        botCount = Number(row.bot)
        if (!q.link_id.length) {
          const orphanRow = await db
            .selectFrom("visit_days")
            .select(sql<number>`coalesce(sum(count), 0)`.as("total"))
            .where((eb) => eb.and([...scope, sql<SqlBool>`link_id is null`]))
            .executeTakeFirstOrThrow()
          orphans = Number(orphanRow.total)
        }
      }
      return { visits: humanCount + botCount, human: humanCount, bot: botCount, orphans }
    },
    { in: { source: detail ? "detail" : "rollup" } },
  )
}

export function getTimeseries(db: Db, q: AnalyticsQuery): Promise<StatsBucket[]> {
  const detail = needsDetail(q)
  return span(
    "analytics.timeseries",
    () => {
      if (!detail) return aggregateRollup(db, rollupScope(q), "day")
      const key = DETAIL_KEY.day
      return db
        .selectFrom("visits")
        .select([key.as("key"), human.as("human"), bot.as("bot")])
        .where((eb) => eb.and(detailFilters(q)))
        .groupBy(key)
        .orderBy(key, "asc")
        .execute()
        .then(toBuckets)
    },
    { in: { source: detail ? "detail" : "rollup" } },
  )
}

export function getBreakdown(db: Db, q: AnalyticsBreakdownQuery): Promise<StatsBucket[]> {
  const detail = needsDetail(q)
  return span(
    "analytics.breakdown",
    () => {
      if (!detail) return aggregateRollup(db, rollupScope(q), q.dimension)
      const key = DETAIL_KEY[q.dimension]
      return db
        .selectFrom("visits")
        .select([key.as("key"), human.as("human"), bot.as("bot")])
        .where((eb) => eb.and(detailFilters(q)))
        .groupBy(key)
        .orderBy(sql<number>`count(*)`, "desc")
        .orderBy(key, "asc")
        .execute()
        .then(toBuckets)
    },
    { in: { source: detail ? "detail" : "rollup" } },
  )
}
