import { NOT_RECORDED, type Platform, type Visit, visitListQuerySchema } from "@linq/shared"
import { sql, type RawBuilder, type Selectable, type SqlBool } from "kysely"
import { Hono } from "hono"
import type { DB } from "../../db/types.generated.ts"
import type { Env } from "../env.ts"
import { validate } from "../validate.ts"

type VisitFilter = RawBuilder<SqlBool>

function toVisit(row: Selectable<DB["visits"]>): Visit {
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

function toInstant(date: string): Date {
  return new Date(date.includes("T") ? date : `${date}T00:00:00Z`)
}

function dimensionFilter(column: "os" | "browser", values: string[]): VisitFilter | undefined {
  if (!values.length) return undefined
  const named = values.filter((value) => value !== "")
  if (!named.length) return sql<SqlBool>`${sql.ref(column)} is null`
  if (named.length === values.length)
    return sql<SqlBool>`${sql.ref(column)} in (${sql.join(named)})`
  return sql<SqlBool>`(${sql.ref(column)} in (${sql.join(named)}) or ${sql.ref(column)} is null)`
}

/** Everything that narrows the raw log. Each predicate is parameterized by
 * Kysely; the unqualified column references are safe because callers select
 * from `visits` alone. */
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
}): VisitFilter[] {
  const filters: VisitFilter[] = []
  if (q.from) filters.push(sql<SqlBool>`occurred_at >= ${toInstant(q.from)}`)
  if (q.to) {
    filters.push(
      q.to.includes("T")
        ? sql<SqlBool>`occurred_at <= ${new Date(q.to)}`
        : sql<SqlBool>`occurred_at < (${q.to}::date + 1)`,
    )
  }
  if (q.bot && q.bot !== "any") filters.push(sql<SqlBool>`is_bot = ${q.bot === "true"}`)
  const linkIds = toArray(q.link_id)
  if (linkIds.length) filters.push(sql<SqlBool>`link_id in (${sql.join(linkIds)})`)
  const domainIds = toArray(q.domain_id)
  if (domainIds.length) filters.push(sql<SqlBool>`domain_id in (${sql.join(domainIds)})`)
  if (q.orphan === "true") filters.push(sql<SqlBool>`link_id is null`)
  const platformValues = toArray(q.platform)
  if (platformValues.length) {
    const named = platformValues.filter((platform): platform is Platform => platform !== NOT_RECORDED)
    filters.push(named.length ? sql<SqlBool>`platform in (${sql.join(named)})` : sql<SqlBool>`false`)
  }
  const os = dimensionFilter("os", toArray(q.os))
  if (os) filters.push(os)
  const browser = dimensionFilter("browser", toArray(q.browser))
  if (browser) filters.push(browser)
  const refererHosts = toArray(q.referer_host)
  if (refererHosts.length)
    filters.push(sql<SqlBool>`referer_host in (${sql.join(refererHosts)})`)
  return filters
}

/** Mounted at /visits; the raw log, newest first. */
export const visitRoutes = new Hono<Env>().get(
  "/",
  validate("query", visitListQuerySchema),
  async (c) => {
    const q = c.req.valid("query")
    const scope = visitFilters(q)
    const rows = await c.var.db
      .selectFrom("visits")
      .selectAll()
      .where((eb) => eb.and(scope))
      .orderBy("occurred_at", "desc")
      .orderBy("id", "desc")
      .limit(q.limit)
      .offset(q.offset)
      .execute()
    const total = await c.var.db
      .selectFrom("visits")
      .select((eb) => eb.fn.countAll<number>().as("total"))
      .where((eb) => eb.and(scope))
      .executeTakeFirstOrThrow()

    return c.json({ data: rows.map(toVisit), total: total.total, limit: q.limit, offset: q.offset })
  },
)
