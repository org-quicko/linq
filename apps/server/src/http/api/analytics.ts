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
import { and, asc, count, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm"
import { Hono } from "hono"
import type { Db } from "../../db/client.ts"
import { visitDays, visits } from "../../db/schema.ts"
import { span } from "../../log.ts"
import type { Env } from "../env.ts"
import { validate } from "../validate.ts"
import { visitFilters } from "./visits.ts"

/** The unfiltered path stays on the day rollup. Its helpers live here now
 * that the legacy /stats route family is gone. */
function dayFilters(q: { from?: string; to?: string }): SQL[] {
  const filters: SQL[] = []
  if (q.from) filters.push(sql`${visitDays.day} >= ${q.from}`)
  if (q.to) filters.push(sql`${visitDays.day} <= ${q.to}`)
  return filters
}

function aggregateVisits(
  db: Db,
  scope: SQL[],
  dimension: AnalyticsDimension | "day",
): Promise<StatsBucket[]> {
  const key =
    dimension === "day"
      ? sql<string>`to_char(${visitDays.day}, 'YYYY-MM-DD')`
      : sql<string>`${visitDays.value}`
  const human = sql<number>`coalesce(sum(${visitDays.count}) filter (where not ${visitDays.is_bot}), 0)`
  const bot = sql<number>`coalesce(sum(${visitDays.count}) filter (where ${visitDays.is_bot}), 0)`
  const volume = sql`sum(${visitDays.count})`
  return db
    .select({ key, human: human.mapWith(Number), bot: bot.mapWith(Number) })
    .from(visitDays)
    .where(and(eq(visitDays.dimension, dimension === "day" ? "total" : dimension), ...scope))
    .groupBy(key)
    .orderBy(...(dimension === "day" ? [asc(key)] : [desc(volume), asc(key)]))
}

/** A filter the day rollup cannot answer. It stores one dimension per row,
 *  so combining two of them — or grouping by one while filtering another —
 *  has to read the visit log. Scope (`link_id`, `domain_id`, `orphan`),
 *  `bot` and the date window are columns of `visit_days` itself and cost
 *  nothing there. docs/adr/0015. */
function needsDetail(q: Pick<AnalyticsQuery, (typeof ANALYTICS_FILTERS)[number]>): boolean {
  return ANALYTICS_FILTERS.some((f) => q[f].length > 0)
}

/** Every expression here reads a column the covering index carries
 *  (`visits_analytics_idx`, schema.ts) — that's what keeps the detail
 *  path's scan index-only. Keyed identically to what the trigger writes
 *  into `visit_days`, so the two paths agree on a bucket's name. */
const DETAIL_KEY = {
  day: sql<string>`to_char(${visits.occurred_at} at time zone 'UTC', 'YYYY-MM-DD')`,
  platform: sql<string>`${visits.platform}::text`,
  os: sql<string>`coalesce(${visits.os}, '')`,
  browser: sql<string>`coalesce(${visits.browser}, '')`,
  referer: sql<string>`${visits.referer_host}`,
  slug: sql<string>`${visits.slug_requested}`,
  destination: sql<string>`coalesce(${visits.destination}, '')`,
} as const

/** The non-dimension scope every rollup-path query shares: the window,
 *  link/domain/orphan scope and the human/bot split. Never includes the
 *  `dimension` predicate — `aggregateVisits` adds its own, and `summary`
 *  adds `'total'` itself. */
function rollupScope(q: AnalyticsQuery): SQL[] {
  const scope: SQL[] = [...dayFilters(q)]
  if (q.link_id.length) scope.push(inArray(visitDays.link_id, q.link_id))
  if (q.domain_id.length) scope.push(inArray(visitDays.domain_id, q.domain_id))
  if (q.orphan === "true") scope.push(isNull(visitDays.link_id))
  if (q.bot !== "any") scope.push(eq(visitDays.is_bot, q.bot === "true"))
  return scope
}

/** The detail path's equivalent of `rollupScope`: every predicate a
 *  filtered report needs, built by the same `visitFilters` `/v1/visits`
 *  uses. `referer` is wired to `referer_host` — the column, not the raw
 *  URL, is what a filter and the covering index key on. */
function detailFilters(q: AnalyticsQuery): SQL[] {
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
  const scope = [eq(visitDays.dimension, "total"), ...rollupScope(q)]
  const [row] = await db
    .select({
      human:
        sql<number>`coalesce(sum(${visitDays.count}) filter (where not ${visitDays.is_bot}), 0)`.mapWith(
          Number,
        ),
      bot: sql<number>`coalesce(sum(${visitDays.count}) filter (where ${visitDays.is_bot}), 0)`.mapWith(
        Number,
      ),
    })
    .from(visitDays)
    .where(and(...scope))

  const orphans = q.link_id.length ? 0 : await rollupOrphans(db, scope)
  return { visits: row.human + row.bot, human: row.human, bot: row.bot, orphans }
}

async function rollupOrphans(db: Db, scope: SQL[]): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${visitDays.count}), 0)`.mapWith(Number) })
    .from(visitDays)
    .where(and(...scope, isNull(visitDays.link_id)))
  return row.total
}

async function detailSummary(db: Db, q: AnalyticsQuery): Promise<AnalyticsSummary> {
  const filters = detailFilters(q)
  const [row] = await db
    .select({
      human: sql<number>`count(*) filter (where not ${visits.is_bot})`.mapWith(Number),
      bot: sql<number>`count(*) filter (where ${visits.is_bot})`.mapWith(Number),
    })
    .from(visits)
    .where(and(...filters))

  const orphans = q.link_id.length ? 0 : await detailOrphans(db, filters)
  return { visits: row.human + row.bot, human: row.human, bot: row.bot, orphans }
}

async function detailOrphans(db: Db, filters: SQL[]): Promise<number> {
  const [{ total }] = await db
    .select({ total: count() })
    .from(visits)
    .where(and(...filters, isNull(visits.link_id)))
  return total
}

async function detailTimeseries(db: Db, q: AnalyticsQuery): Promise<StatsBucket[]> {
  const key = DETAIL_KEY.day
  return db
    .select({
      key,
      human: sql<number>`count(*) filter (where not ${visits.is_bot})`.mapWith(Number),
      bot: sql<number>`count(*) filter (where ${visits.is_bot})`.mapWith(Number),
    })
    .from(visits)
    .where(and(...detailFilters(q)))
    .groupBy(key)
    .orderBy(asc(key))
}

async function detailBreakdown(db: Db, q: AnalyticsBreakdownQuery): Promise<StatsBucket[]> {
  const key = DETAIL_KEY[q.dimension]
  const human = sql<number>`count(*) filter (where not ${visits.is_bot})`
  const bot = sql<number>`count(*) filter (where ${visits.is_bot})`
  const volume = sql`count(*)`
  return db
    .select({ key, human: human.mapWith(Number), bot: bot.mapWith(Number) })
    .from(visits)
    .where(and(...detailFilters(q)))
    .groupBy(key)
    .orderBy(desc(volume), asc(key))
}

/**
 * Mounted at /analytics. Three routes sharing one filter vocabulary: no
 * dimension filter reads the day-wise rollup, pre-counted and never
 * touching `visits`; any dimension filter (`referer`/`os`/`browser`/
 * `platform`) reads the visit log through the covering index instead,
 * because the rollup stores one dimension per row and cannot answer a
 * combination. docs/adr/0015.
 */
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
