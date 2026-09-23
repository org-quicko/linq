import { NOT_RECORDED, type Platform, type Visit, visitListQuerySchema } from "@linq/shared"
import { and, type Column, count, desc, eq, gte, inArray, isNull, lte, or, type SQL, sql } from "drizzle-orm"
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

type Many<T> = T | T[] | undefined

function toArray<T>(v: Many<T>): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v]
}

/** `from`/`to` come in two shapes: a full instant (`/v1/visits`'s own
 *  schema, unchanged) or a bare date (analytics.ts's window, always
 *  `YYYY-MM-DD`). A bare date can't just become `new Date(...)` for `to` —
 *  that lands on midnight and silently drops the day, the same bug the
 *  rollup's `day <= to` never had. Detected by the presence of a `T`, since
 *  neither shape is ever ambiguous with the other. */
function toInstant(date: string): Date {
  return new Date(date.includes("T") ? date : `${date}T00:00:00Z`)
}

/** `values` may hold `''`, the rollup's spelling of "not recorded"
 *  (schema.ts:216) — but on the raw row that dimension is SQL NULL, not
 *  `''` (`visits/platform.ts` never stores an empty string). Matching it
 *  needs `IS NULL`, not `= ''`. */
function dimensionFilter(column: Column, values: string[]): SQL | undefined {
  if (!values.length) return undefined
  const named = values.filter((v) => v !== "")
  const clauses: SQL[] = []
  if (named.length) clauses.push(inArray(column, named))
  if (named.length !== values.length) clauses.push(isNull(column))
  return clauses.length === 1 ? clauses[0] : or(...clauses)
}

/**
 * Everything that narrows the raw log: an inclusive `from`/`to` window, the
 * human/bot split, and the same scoping predicates the stats/analytics
 * endpoints use. Every list-shaped field is OR'd within itself and AND'd
 * against the rest — the same convention `links.ts`'s `tags` already uses.
 * A field takes either one value (`/v1/visits`'s own schema, unchanged) or
 * a list (`analytics.ts`'s `csvList` fields), so one builder serves both
 * without either caller having to normalise first.
 */
export function visitFilters(q: {
  from?: string
  to?: string
  bot?: "true" | "false" | "any"
  link_id?: Many<string>
  domain_id?: Many<string>
  orphan?: "true" | "false"
  platform?: Many<Platform | typeof NOT_RECORDED>
  os?: Many<string>
  browser?: Many<string>
  referer_host?: Many<string>
}): SQL[] {
  const filters: SQL[] = []
  if (q.from) filters.push(gte(visits.occurred_at, toInstant(q.from)))
  if (q.to) {
    filters.push(
      q.to.includes("T")
        ? lte(visits.occurred_at, new Date(q.to))
        : sql`${visits.occurred_at} < (${q.to}::date + 1)`,
    )
  }
  if (q.bot && q.bot !== "any") filters.push(eq(visits.is_bot, q.bot === "true"))
  const link_id = toArray(q.link_id)
  if (link_id.length) filters.push(inArray(visits.link_id, link_id))
  const domain_id = toArray(q.domain_id)
  if (domain_id.length) filters.push(inArray(visits.domain_id, domain_id))
  if (q.orphan === "true") filters.push(isNull(visits.link_id))
  // Platform is NOT NULL and has no "(none)" state (visits/platform.ts always
  // names one) — a stray NOT_RECORDED token can only mean "match nothing",
  // never "match everything" or a Postgres enum-cast error.
  const platformValues = toArray(q.platform)
  if (platformValues.length) {
    const named = platformValues.filter((p): p is Platform => p !== NOT_RECORDED)
    filters.push(named.length ? inArray(visits.platform, named) : sql`false`)
  }
  const os = dimensionFilter(visits.os, toArray(q.os))
  if (os) filters.push(os)
  const browser = dimensionFilter(visits.browser, toArray(q.browser))
  if (browser) filters.push(browser)
  const referer_host = toArray(q.referer_host)
  if (referer_host.length) filters.push(inArray(visits.referer_host, referer_host))
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
