import { type Platform, type Visit, visitListQuerySchema } from "@linq/shared"
import { and, count, desc, eq, gte, isNull, lte, type SQL } from "drizzle-orm"
import { Hono } from "hono"
import { visits } from "../../db/schema.ts"
import type { Env } from "../env.ts"
import { validate } from "../validate.ts"

/** Maps a visit row to the JSON shape the API returns. */
function toVisit(row: typeof visits.$inferSelect): Visit {
  return {
    id: row.id,
    link_id: row.link_id,
    domain_id: row.domain_id,
    slug_requested: row.slug_requested,
    occurred_at: row.occurred_at.toISOString(),
    is_bot: row.is_bot,
    platform: row.platform,
    os: row.os,
    browser: row.browser,
    user_agent: row.user_agent,
    referer: row.referer,
    destination: row.destination,
    query: row.query,
  }
}

/**
 * Everything that narrows the raw log: an inclusive `from`/`to` window, the
 * human/bot split, and the same three scoping predicates the stats endpoints
 * use. `bot=any` and `orphan=false` add no predicate.
 */
function visitFilters(q: {
  from?: string
  to?: string
  bot?: "true" | "false" | "any"
  link_id?: string
  domain_id?: string
  orphan?: "true" | "false"
  platform?: Platform
  os?: string
  browser?: string
}): SQL[] {
  const filters: SQL[] = []
  if (q.from) filters.push(gte(visits.occurred_at, new Date(q.from)))
  if (q.to) filters.push(lte(visits.occurred_at, new Date(q.to)))
  if (q.bot && q.bot !== "any") filters.push(eq(visits.is_bot, q.bot === "true"))
  if (q.link_id) filters.push(eq(visits.link_id, q.link_id))
  if (q.domain_id) filters.push(eq(visits.domain_id, q.domain_id))
  if (q.orphan === "true") filters.push(isNull(visits.link_id))
  if (q.platform) filters.push(eq(visits.platform, q.platform))
  if (q.os) filters.push(eq(visits.os, q.os))
  if (q.browser) filters.push(eq(visits.browser, q.browser))
  return filters
}

/**
 * Mounted at /visits; the raw log, newest first, narrowed by `link_id`,
 * `domain_id` or `orphan` — one route rather than one per scope, because the
 * only thing that changes between them is a predicate.
 *
 * Unlike the stats endpoints this reads the detail table: a visit row is the
 * only place a user agent, a query string or an exact instant survives.
 */
export const visitRoutes = new Hono<Env>().get(
  "/",
  validate("query", visitListQuerySchema),
  async (c) => {
    const q = c.req.valid("query")
    const scope = visitFilters(q)
    const where = scope.length ? and(...scope) : undefined

    const rows = await c.var.db
      .select()
      .from(visits)
      .where(where)
      // `id` is a UUIDv7, so it breaks ties in the order the visits happened.
      .orderBy(desc(visits.occurred_at), desc(visits.id))
      .limit(q.limit)
      .offset(q.offset)
    const [{ total }] = await c.var.db.select({ total: count() }).from(visits).where(where)

    return c.json({ data: rows.map(toVisit), total, limit: q.limit, offset: q.offset })
  },
)
