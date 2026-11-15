import { NOT_RECORDED, type Platform, type Visit } from "@linq/shared"
import { type Insertable, type RawBuilder, type Selectable, type SqlBool, sql } from "kysely"
import type { DB } from "../db/types.generated.ts"
import { type Db, reqLog, span } from "../libs/index.ts"

export type VisitInput = Omit<Insertable<DB["visits"]>, "id" | "visited_at">
export type VisitFilter = RawBuilder<SqlBool>

/** Every narrowing the raw log accepts. Multi-valued filters are OR-ed within themselves. */
export type VisitFilterQuery = {
  from?: string
  to?: string
  bot?: "true" | "false" | "any"
  link_id: string[]
  domain_id: string[]
  orphan?: "true" | "false"
  platform: (Platform | typeof NOT_RECORDED)[]
  os: string[]
  browser: string[]
  referer_host: string[]
  utm_source: string[]
  utm_medium: string[]
  utm_campaign: string[]
  utm_content: string[]
  utm_term: string[]
  device_type: string[]
}

/** Open-vocabulary columns, where `""` on the wire stands for "never recorded". */
const OPEN_DIMENSIONS = [
  "os",
  "browser",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "device_type",
] as const

/** In-flight inserts, so a shutdown or a test can wait for them. */
const pending = new Set<Promise<unknown>>()
let warnedAtCapacity = false

function toVisit(row: Selectable<DB["visits"]>): Visit {
  return {
    id: row.id,
    link_id: row.link_id,
    domain_id: row.domain_id,
    slug_requested: row.slug_requested,
    visited_at: row.visited_at.toISOString(),
    is_bot: row.is_bot,
    bot_classification_reason: row.bot_classification_reason,
    platform: row.platform,
    os: row.os,
    browser: row.browser,
    user_agent: row.user_agent,
    referer: row.referer,
    destination: row.destination,
    query_params: row.query_params,
  }
}

/**
 * Fire-and-forget on purpose: a visit must never delay a redirect, and a failed
 * insert must never turn a working link into an error.
 */
export function recordVisit(db: Db, visit: VisitInput, maxPending: number): void {
  // Visits enrich analytics but must never let a traffic spike build an
  // unbounded database backlog or delay a redirect. Resume recording once the
  // backlog drains below the configured cap.
  if (pending.size >= maxPending) {
    if (!warnedAtCapacity) {
      warnedAtCapacity = true
      reqLog().warn({ maxPending }, "visit queue full; dropping analytics event")
    }
    return
  }

  const insert = span(
    "visit.record",
    () =>
      db
        .insertInto("visits")
        .values({ id: Bun.randomUUIDv7(), ...visit })
        .execute(),
    {
      in: {
        link_id: visit.link_id ?? null,
        domain_id: visit.domain_id,
        slug: visit.slug_requested,
      },
    },
  )
    // `reqLog()` still resolves here: the insert is not awaited, but it starts
    // inside the redirect request's async scope, so a failure correlates to it.
    .catch((err) => reqLog().error({ err, link_id: visit.link_id ?? null }, "visit insert failed"))
    .finally(() => {
      pending.delete(insert)
      if (pending.size < maxPending) warnedAtCapacity = false
    })
  pending.add(insert)
}

/** Waits for every visit already handed to `recordVisit`. */
export async function flushVisits(): Promise<void> {
  while (pending.size) await Promise.all([...pending])
}

/**
 * Everything that narrows the raw log. Each predicate is parameterized by
 * Kysely; the unqualified column references are safe because callers select
 * from `visits` alone.
 */
export function visitFilters(q: VisitFilterQuery): VisitFilter[] {
  const filters: VisitFilter[] = []
  if (q.from) {
    const from = new Date(q.from.includes("T") ? q.from : `${q.from}T00:00:00Z`)
    filters.push(sql<SqlBool>`visited_at >= ${from}`)
  }
  if (q.to) {
    filters.push(
      q.to.includes("T")
        ? sql<SqlBool>`visited_at <= ${new Date(q.to)}`
        : sql<SqlBool>`visited_at < (${q.to}::date + 1)`,
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
  for (const column of OPEN_DIMENSIONS) {
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

/** The raw log, newest first. */
export async function listVisits(
  db: Db,
  filters: VisitFilter[],
  { limit, offset }: { limit: number; offset: number },
) {
  const rows = await db
    .selectFrom("visits")
    .selectAll()
    .where((eb) => eb.and(filters))
    .orderBy("visited_at", "desc")
    .orderBy("id", "desc")
    .limit(limit)
    .offset(offset)
    .execute()
  const { total } = await db
    .selectFrom("visits")
    .select((eb) => eb.fn.countAll<number>().as("total"))
    .where((eb) => eb.and(filters))
    .executeTakeFirstOrThrow()
  return { data: rows.map(toVisit), total }
}
