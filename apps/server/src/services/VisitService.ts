import { NOT_RECORDED, type Platform, type Visit } from "@linq/shared"
import type { AnyValue, Logger } from "@opentelemetry/api"
import { type ExportResult, ExportResultCode, hrTimeToMilliseconds } from "@opentelemetry/core"
import {
  LoggerProvider,
  type LogRecordExporter,
  type ReadableLogRecord,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs"
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

/** The cap `recordVisit` was last given, so an insert settling can re-arm the warning. */
let capacity = Number.POSITIVE_INFINITY

/**
 * The end of the visit pipeline: an OpenTelemetry log exporter whose "backend"
 * is the `visits` table. Each record's body is one visit; exporting it is the
 * INSERT. The rollup trigger then runs exactly as for any other insert.
 *
 * `SimpleLogRecordProcessor` calls `export` synchronously from `emit`, one record
 * at a time, so a visit is written the moment it arrives, still inside the
 * redirect request's async scope (which is what lets `reqLog()` below correlate a
 * failure to it). The processor's own `forceFlush` does not wait on exports, so
 * in-flight inserts are tracked in `pending`, which `flushVisits` drains.
 */
class VisitTableExporter implements LogRecordExporter {
  constructor(private readonly db: Db) {}

  export(records: ReadableLogRecord[], done: (result: ExportResult) => void): void {
    const rows = records.map((record) => ({
      id: Bun.randomUUIDv7(),
      ...(record.body as unknown as VisitInput),
      // The click's own time, stamped at emit, rather than the insert's `now()`.
      visited_at: new Date(hrTimeToMilliseconds(record.hrTime)),
    }))
    const first = rows[0]
    const insert = span("visit.record", () => this.db.insertInto("visits").values(rows).execute(), {
      in: {
        link_id: first?.link_id ?? null,
        domain_id: first?.domain_id,
        slug: first?.slug_requested,
      },
    })
      .then(
        () => done({ code: ExportResultCode.SUCCESS }),
        (error: Error) => {
          // Logged here, once, with the request's context. The processor hands the
          // failure to OpenTelemetry's global error handler, which is silent unless
          // a diag logger is installed.
          reqLog().error({ err: error, link_id: first?.link_id ?? null }, "visit insert failed")
          done({ code: ExportResultCode.FAILED, error })
        },
      )
      .finally(() => {
        pending.delete(insert)
        if (pending.size < capacity) warnedAtCapacity = false
      })
    pending.add(insert)
  }

  forceFlush(): Promise<void> {
    return flushVisits()
  }

  shutdown(): Promise<void> {
    return flushVisits()
  }
}

/** One OpenTelemetry logger per database handle. Weakly held, so a test suite's
 *  PGlite instance can still be collected once the suite is done with it. */
const visitLoggers = new WeakMap<Db, Logger>()

function visitLogger(db: Db): Logger {
  let logger = visitLoggers.get(db)
  if (!logger) {
    const provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({ exporter: new VisitTableExporter(db) })],
    })
    logger = provider.getLogger("linq.visits")
    visitLoggers.set(db, logger)
  }
  return logger
}

/**
 * Hands one visit to the OpenTelemetry pipeline, which writes it to `visits`
 * immediately (see `VisitTableExporter`).
 *
 * Fire-and-forget on purpose: a visit must never delay a redirect, and a failed
 * insert must never turn a working link into an error.
 */
export function recordVisit(db: Db, visit: VisitInput, maxPending: number): void {
  // Visits enrich analytics but must never let a traffic spike build an
  // unbounded database backlog or delay a redirect. Resume recording once the
  // backlog drains below the configured cap. The Simple processor has no queue
  // limit of its own, so this check is the only one.
  capacity = maxPending
  if (pending.size >= maxPending) {
    if (!warnedAtCapacity) {
      warnedAtCapacity = true
      reqLog().warn({ maxPending }, "visit queue full; dropping analytics event")
    }
    return
  }

  visitLogger(db).emit({
    eventName: "linq.visit",
    timestamp: new Date(),
    body: visit as unknown as AnyValue,
  })
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
    // A bare date ends at the next UTC midnight, computed here as an instant.
    // `${to}::date + 1` would be cast to timestamptz in the session's TimeZone,
    // cutting the day short (or running it long) on a non-UTC database.
    filters.push(
      q.to.includes("T")
        ? sql<SqlBool>`visited_at <= ${new Date(q.to)}`
        : sql<SqlBool>`visited_at < ${new Date(Date.parse(`${q.to}T00:00:00Z`) + 86_400_000)}`,
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
