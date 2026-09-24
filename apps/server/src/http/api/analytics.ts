import {
  ANALYTICS_FILTERS,
  type AnalyticsBreakdownQuery,
  type AnalyticsDimension,
  type AnalyticsQuery,
  type AnalyticsSummary,
  analyticsBreakdownQuerySchema,
  analyticsSummaryQuerySchema,
  analyticsTimeseriesQuerySchema,
  type StatsBucket,
} from "@linq/shared"
import { sql, type RawBuilder, type SqlBool } from "kysely"
import { Hono } from "hono"
import type { Db } from "../../db/client.ts"
import { span } from "../../log.ts"
import type { Env } from "../env.ts"
import { validate } from "../validate.ts"
import { visitFilters } from "./visits.ts"

type Filter = RawBuilder<SqlBool>

function dayFilters(q: { from?: string; to?: string }): Filter[] {
  const filters: Filter[] = []
  if (q.from) filters.push(sql<SqlBool>`day >= ${q.from}`)
  if (q.to) filters.push(sql<SqlBool>`day <= ${q.to}`)
  return filters
}

function aggregateVisits(
  db: Db,
  scope: Filter[],
  dimension: AnalyticsDimension | "day",
): Promise<StatsBucket[]> {
  const key =
    dimension === "day"
      ? sql<string>`to_char(day, 'YYYY-MM-DD')`
      : sql<string>`${sql.ref("value")}`
  const human = sql<number>`coalesce(sum(count) filter (where not is_bot), 0)`
  const bot = sql<number>`coalesce(sum(count) filter (where is_bot), 0)`
  const volume = sql<number>`sum(count)`
  return db
    .selectFrom("visit_days")
    .select([key.as("key"), human.as("human"), bot.as("bot")])
    .where("dimension", "=", dimension === "day" ? "total" : dimension)
    .where((eb) => eb.and(scope))
    .groupBy(key)
    .orderBy(dimension === "day" ? key : volume, dimension === "day" ? "asc" : "desc")
    .execute()
    .then((rows) => rows.map((row) => ({ ...row, human: Number(row.human), bot: Number(row.bot) })))
}

function needsDetail(q: Pick<AnalyticsQuery, (typeof ANALYTICS_FILTERS)[number]>): boolean {
  return ANALYTICS_FILTERS.some((filter) => q[filter].length > 0)
}

const DETAIL_KEY = {
  day: sql<string>`to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD')`,
  platform: sql<string>`platform::text`,
  os: sql<string>`coalesce(os, '')`,
  browser: sql<string>`coalesce(browser, '')`,
  referer: sql<string>`referer_host`,
  slug: sql<string>`slug_requested`,
  destination: sql<string>`coalesce(destination, '')`,
} as const

function rollupScope(q: AnalyticsQuery): Filter[] {
  const scope = [...dayFilters(q)]
  if (q.link_id.length) scope.push(sql<SqlBool>`link_id in (${sql.join(q.link_id)})`)
  if (q.domain_id.length) scope.push(sql<SqlBool>`domain_id in (${sql.join(q.domain_id)})`)
  if (q.orphan === "true") scope.push(sql<SqlBool>`link_id is null`)
  if (q.bot !== "any") scope.push(sql<SqlBool>`is_bot = ${q.bot === "true"}`)
  return scope
}

function detailFilters(q: AnalyticsQuery): Filter[] {
  return visitFilters({
    from: q.from,
    to: q.to,
    bot: q.bot,
    link_id: q.link_id,
    domain_id: q.domain_id,
    orphan: q.orphan,
    platform: q.platform,
    os: q.os,
    browser: q.browser,
    referer_host: q.referer,
  })
}

async function rollupSummary(db: Db, q: AnalyticsQuery): Promise<AnalyticsSummary> {
  const scope = [sql<SqlBool>`dimension = 'total'`, ...rollupScope(q)]
  const row = await db
    .selectFrom("visit_days")
    .select([
      sql<number>`coalesce(sum(count) filter (where not is_bot), 0)`.as("human"),
      sql<number>`coalesce(sum(count) filter (where is_bot), 0)`.as("bot"),
    ])
    .where((eb) => eb.and(scope))
    .executeTakeFirstOrThrow()
  const orphans = q.link_id.length ? 0 : await rollupOrphans(db, scope)
  const human = Number(row.human)
  const bot = Number(row.bot)
  return { visits: human + bot, human, bot, orphans }
}

async function rollupOrphans(db: Db, scope: Filter[]): Promise<number> {
  const row = await db
    .selectFrom("visit_days")
    .select(sql<number>`coalesce(sum(count), 0)`.as("total"))
    .where((eb) => eb.and([...scope, sql<SqlBool>`link_id is null`]))
    .executeTakeFirstOrThrow()
  return Number(row.total)
}

async function detailSummary(db: Db, q: AnalyticsQuery): Promise<AnalyticsSummary> {
  const filters = detailFilters(q)
  const row = await db
    .selectFrom("visits")
    .select([
      sql<number>`count(*) filter (where not is_bot)`.as("human"),
      sql<number>`count(*) filter (where is_bot)`.as("bot"),
    ])
    .where((eb) => eb.and(filters))
    .executeTakeFirstOrThrow()
  const orphans = q.link_id.length ? 0 : await detailOrphans(db, filters)
  const human = Number(row.human)
  const bot = Number(row.bot)
  return { visits: human + bot, human, bot, orphans }
}

async function detailOrphans(db: Db, filters: Filter[]): Promise<number> {
  const row = await db
    .selectFrom("visits")
    .select((eb) => eb.fn.countAll<number>().as("total"))
    .where((eb) => eb.and([...filters, sql<SqlBool>`link_id is null`]))
    .executeTakeFirstOrThrow()
  return Number(row.total)
}

async function detailTimeseries(db: Db, q: AnalyticsQuery): Promise<StatsBucket[]> {
  const key = DETAIL_KEY.day
  return db
    .selectFrom("visits")
    .select([
      key.as("key"),
      sql<number>`count(*) filter (where not is_bot)`.as("human"),
      sql<number>`count(*) filter (where is_bot)`.as("bot"),
    ])
    .where((eb) => eb.and(detailFilters(q)))
    .groupBy(key)
    .orderBy(key, "asc")
    .execute()
    .then((rows) => rows.map((row) => ({ ...row, human: Number(row.human), bot: Number(row.bot) })))
}

async function detailBreakdown(db: Db, q: AnalyticsBreakdownQuery): Promise<StatsBucket[]> {
  const key = DETAIL_KEY[q.dimension]
  const volume = sql<number>`count(*)`
  return db
    .selectFrom("visits")
    .select([
      key.as("key"),
      sql<number>`count(*) filter (where not is_bot)`.as("human"),
      sql<number>`count(*) filter (where is_bot)`.as("bot"),
    ])
    .where((eb) => eb.and(detailFilters(q)))
    .groupBy(key)
    .orderBy(volume, "desc")
    .orderBy(key, "asc")
    .execute()
    .then((rows) => rows.map((row) => ({ ...row, human: Number(row.human), bot: Number(row.bot) })))
}

/** Mounted at /analytics. Dimension filters read the raw log; otherwise the
 * pre-aggregated day rollup answers the request. */
export const analyticsRoutes = new Hono<Env>()
  .get("/summary", validate("query", analyticsSummaryQuerySchema), async (c) => {
    const q = c.req.valid("query")
    const detail = needsDetail(q)
    const result = await span(
      "analytics.summary",
      () => (detail ? detailSummary(c.var.db, q) : rollupSummary(c.var.db, q)),
      { in: { source: detail ? "detail" : "rollup" } },
    )
    return c.json(result)
  })
  .get("/timeseries", validate("query", analyticsTimeseriesQuerySchema), async (c) => {
    const q = c.req.valid("query")
    const detail = needsDetail(q)
    const buckets = await span(
      "analytics.timeseries",
      () =>
        detail ? detailTimeseries(c.var.db, q) : aggregateVisits(c.var.db, rollupScope(q), "day"),
      { in: { source: detail ? "detail" : "rollup" } },
    )
    return c.json(buckets)
  })
  .get("/breakdown", validate("query", analyticsBreakdownQuerySchema), async (c) => {
    const q = c.req.valid("query")
    const detail = needsDetail(q)
    const buckets = await span(
      "analytics.breakdown",
      () =>
        detail
          ? detailBreakdown(c.var.db, q)
          : aggregateVisits(c.var.db, rollupScope(q), q.dimension),
      { in: { source: detail ? "detail" : "rollup" } },
    )
    return c.json(buckets)
  })
