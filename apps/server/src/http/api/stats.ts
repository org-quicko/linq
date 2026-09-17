import {
  type GroupBy,
  globalStatsQuerySchema,
  type StatsBucket,
  statsQuerySchema,
  uuidSchema,
} from "@linq/shared"
import { and, asc, desc, eq, gte, isNull, lte, type SQL, sql } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { Db } from "../../db/client.ts"
import { visitDays } from "../../db/schema.ts"
import { span } from "../../log.ts"
import type { Env } from "../env.ts"
import { validate } from "../validate.ts"
import { loadLink } from "./links.ts"

const idParam = validate("param", z.object({ id: uuidSchema }))

/**
 * The rollup dimension a `groupBy` reads.
 *
 * `day` is the one that does not name a dimension of its own: it groups the
 * `total` rows by their date rather than by their value. Every other grouping
 * is its own dimension, stored with `''` where nothing was recorded — a real
 * referer or destination could collide with a word like "unknown".
 */
function dimensionOf(groupBy: GroupBy) {
  return groupBy === "day" ? "total" : groupBy
}

/** The window every report shares: whole UTC days, both ends inclusive. */
export function dayFilters(q: { from?: string; to?: string }): SQL[] {
  const filters: SQL[] = []
  if (q.from) filters.push(gte(visitDays.day, q.from))
  if (q.to) filters.push(lte(visitDays.day, q.to))
  return filters
}

/**
 * Counts visits per bucket, split human and bot, out of the day-wise rollup.
 *
 * Nothing here scans the visits table: every number was counted by the trigger
 * that recorded the visit, and this sums pre-counted rows. See docs/adr/0007.
 *
 * Days come back in chronological order so a chart can plot them as given;
 * every other dimension is ranked by volume, busiest first. A bucket with no
 * visits is absent rather than zero — only the client knows which days the
 * window was meant to cover, so it is the one that fills the gaps.
 */
export function aggregateVisits(db: Db, scope: SQL[], groupBy: GroupBy): Promise<StatsBucket[]> {
  const key =
    groupBy === "day"
      ? sql<string>`to_char(${visitDays.day}, 'YYYY-MM-DD')`
      : sql<string>`${visitDays.value}`
  const human = sql<number>`coalesce(sum(${visitDays.count}) filter (where not ${visitDays.isBot}), 0)`
  const bot = sql<number>`coalesce(sum(${visitDays.count}) filter (where ${visitDays.isBot}), 0)`
  const volume = sql`sum(${visitDays.count})`

  return span(
    "stats.aggregate",
    () =>
      db
        .select({ key, human: human.mapWith(Number), bot: bot.mapWith(Number) })
        .from(visitDays)
        .where(and(eq(visitDays.dimension, dimensionOf(groupBy)), ...scope))
        .groupBy(key)
        .orderBy(...(groupBy === "day" ? [asc(key)] : [desc(volume), asc(key)])),
    { in: { groupBy }, out: (buckets) => ({ buckets: buckets.length }) },
  )
}

/** Mounted on /links; the grouped visit totals of one link. */
export const linkStatsRoutes = new Hono<Env>().get(
  "/:id/stats",
  idParam,
  validate("query", statsQuerySchema),
  async (c) => {
    const { id } = c.req.valid("param")
    const q = c.req.valid("query")
    // Load first, so an unknown link is a 404 rather than an empty report.
    await loadLink(c.var.db, id)

    const scope = [eq(visitDays.linkId, id), ...dayFilters(q)]
    return c.json(await aggregateVisits(c.var.db, scope, q.groupBy))
  },
)

/**
 * Mounted on /domains; every visit on one domain, orphans included.
 *
 * The domain is not loaded first: unlike a link, an archived domain still has a
 * history worth reading, and an unknown id simply reports nothing.
 */
export const domainStatsRoutes = new Hono<Env>().get(
  "/:id/stats",
  idParam,
  validate("query", statsQuerySchema),
  async (c) => {
    const { id } = c.req.valid("param")
    const q = c.req.valid("query")
    const scope = [eq(visitDays.domainId, id), ...dayFilters(q)]
    return c.json(await aggregateVisits(c.var.db, scope, q.groupBy))
  },
)

/**
 * Mounted at /stats; the whole instance, optionally narrowed to one domain or
 * to the orphan slice (`orphan=true`), which is the visits that resolved to no
 * link at all.
 */
export const globalStatsRoutes = new Hono<Env>().get(
  "/",
  validate("query", globalStatsQuerySchema),
  async (c) => {
    const q = c.req.valid("query")
    const scope = dayFilters(q)
    if (q.orphan === "true") scope.push(isNull(visitDays.linkId))
    if (q.domainId) scope.push(eq(visitDays.domainId, q.domainId))
    return c.json(await aggregateVisits(c.var.db, scope, q.groupBy))
  },
)
