import {
  type GroupBy,
  globalStatsQuerySchema,
  type StatsBucket,
  statsQuerySchema,
  uuidSchema,
} from "@linq/shared"
import { and, asc, desc, eq, isNull, type SQL, sql } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { Db } from "../../db/client.ts"
import { clicks } from "../../db/schema.ts"
import { span } from "../../log.ts"
import type { Env } from "../env.ts"
import { validate } from "../validate.ts"
import { clickFilters } from "./clicks.ts"
import { loadLinq } from "./linqs.ts"

const idParam = validate("param", z.object({ id: uuidSchema }))

/**
 * The SQL expression a `groupBy` buckets on.
 *
 * Days are cut in UTC so a report does not shift with the database session's
 * timezone. Every other dimension is nullable, and a null becomes an empty key
 * rather than a word like "unknown", which a real referer or region could collide with.
 */
function bucketKey(groupBy: GroupBy): SQL<string> {
  switch (groupBy) {
    case "day":
      return sql<string>`to_char(${clicks.occurredAt} at time zone 'UTC', 'YYYY-MM-DD')`
    case "country":
      return sql<string>`coalesce(${clicks.country}, '')`
    case "region":
      return sql<string>`coalesce(${clicks.region}, '')`
    case "platform":
      return sql<string>`${clicks.platform}::text`
    case "referer":
      return sql<string>`coalesce(${clicks.referer}, '')`
    case "destination":
      return sql<string>`coalesce(${clicks.destination}, '')`
    case "slug":
      return sql<string>`${clicks.slugRequested}`
  }
}

/**
 * Counts clicks per bucket, split human and bot, straight out of Postgres.
 *
 * There are no counters or rollups to keep in step: every number here is a live
 * aggregate over `clicks`, served by the indexes on the table.
 *
 * Days come back in chronological order so a chart can plot them as given;
 * every other dimension is ranked by volume, busiest first.
 */
export function aggregateClicks(db: Db, scope: SQL[], groupBy: GroupBy): Promise<StatsBucket[]> {
  const key = bucketKey(groupBy)
  const human = sql<number>`count(*) filter (where not ${clicks.isBot})`
  const bot = sql<number>`count(*) filter (where ${clicks.isBot})`

  return span(
    "stats.aggregate",
    () =>
      db
        .select({ key, human: human.mapWith(Number), bot: bot.mapWith(Number) })
        .from(clicks)
        .where(scope.length ? and(...scope) : undefined)
        .groupBy(key)
        .orderBy(...(groupBy === "day" ? [asc(key)] : [desc(sql`count(*)`), asc(key)])),
    { in: { groupBy }, out: (buckets) => ({ buckets: buckets.length }) },
  )
}

/** Mounted on /linqs; the grouped click totals of one linq. */
export const linqStatsRoutes = new Hono<Env>().get(
  "/:id/stats",
  idParam,
  validate("query", statsQuerySchema),
  async (c) => {
    const { id } = c.req.valid("param")
    const q = c.req.valid("query")
    // Load first, so an unknown linq is a 404 rather than an empty report.
    await loadLinq(c.var.db, id)

    const scope = [eq(clicks.linqId, id), ...clickFilters(q)]
    return c.json(await aggregateClicks(c.var.db, scope, q.groupBy))
  },
)

/**
 * Mounted on /domains; every click on one domain, orphans included.
 *
 * The domain is not loaded first: unlike a linq, an archived domain still has a
 * history worth reading, and an unknown id simply reports nothing.
 */
export const domainStatsRoutes = new Hono<Env>().get(
  "/:id/stats",
  idParam,
  validate("query", statsQuerySchema),
  async (c) => {
    const { id } = c.req.valid("param")
    const q = c.req.valid("query")
    const scope = [eq(clicks.domainId, id), ...clickFilters(q)]
    return c.json(await aggregateClicks(c.var.db, scope, q.groupBy))
  },
)

/**
 * Mounted at /stats; the whole instance, optionally narrowed to one domain or
 * to the orphan slice (`orphan=true`), which is the clicks that resolved to no
 * linq at all.
 */
export const globalStatsRoutes = new Hono<Env>().get(
  "/",
  validate("query", globalStatsQuerySchema),
  async (c) => {
    const q = c.req.valid("query")
    const scope = clickFilters(q)
    if (q.orphan === "true") scope.push(isNull(clicks.linqId))
    if (q.domainId) scope.push(eq(clicks.domainId, q.domainId))
    return c.json(await aggregateClicks(c.var.db, scope, q.groupBy))
  },
)
