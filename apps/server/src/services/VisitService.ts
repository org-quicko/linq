import type { VisitInput, VisitListQuery } from "@linq/shared"
import type { AnyValue, Logger as OtelLogger } from "@opentelemetry/api"
import { type ExportResult, ExportResultCode } from "@opentelemetry/core"
import {
  LoggerProvider,
  type LogRecordExporter,
  type ReadableLogRecord,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs"
import type { Db } from "../clients/index.ts"
import type { Config } from "../config.ts"
import {
  LogRecordToVisitInsertConverter,
  VisitListQueryToVisitFilterQueryConverter,
  VisitRowToVisitConverter,
} from "../converters/index.ts"
import { Log, Logger } from "../libs/index.ts"
import { FilterUtil } from "../utils/index.ts"

/**
 * Visits: fire-and-forget recording on the redirect's hot path, and the raw
 * log's list. One instance per app owns that app's whole visit pipeline (an
 * OpenTelemetry logger whose exporter is the `visits` table) and the inserts it
 * has in flight, so `flush` drains exactly this app's visits: what shutdown and
 * the tests wait on.
 */
export class VisitService {
  private readonly visitListQueryToVisitFilterQueryConverter: VisitListQueryToVisitFilterQueryConverter
  private readonly visitRowToVisitConverter: VisitRowToVisitConverter
  private readonly exporter: VisitTableExporter
  private readonly logger: OtelLogger
  private warnedAtCapacity = false

  /**
   * @param db - The database visits are written to and read from.
   * @param config - LINQ_VISIT_MAX_PENDING, the most in-flight inserts before visits are dropped.
   */
  constructor(
    private readonly db: Db,
    private readonly config: Pick<Config, "LINQ_VISIT_MAX_PENDING">,
  ) {
    this.visitListQueryToVisitFilterQueryConverter = new VisitListQueryToVisitFilterQueryConverter()
    this.visitRowToVisitConverter = new VisitRowToVisitConverter()
    // An insert settling below the cap re-arms the "queue full" warning.
    this.exporter = new VisitTableExporter(db, () => {
      if (this.exporter.inFlight < this.config.LINQ_VISIT_MAX_PENDING) this.warnedAtCapacity = false
    })
    const provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({ exporter: this.exporter })],
    })
    this.logger = provider.getLogger("linq.visits")
  }

  /**
   * Hands one visit to the OpenTelemetry pipeline, which writes it to `visits`
   * immediately (see `VisitTableExporter`).
   *
   * Fire-and-forget on purpose: a visit must never delay a redirect, and a failed
   * insert must never turn a working link into an error.
   *
   * @param visit - The visit, without its id or click time.
   */
  record(visit: VisitInput): void {
    // Visits enrich analytics but must never let a traffic spike build an
    // unbounded database backlog or delay a redirect. Resume recording once the
    // backlog drains below the configured cap. The Simple processor has no queue
    // limit of its own, so this check is the only one.
    const maxPending = this.config.LINQ_VISIT_MAX_PENDING
    if (this.exporter.inFlight >= maxPending) {
      if (!this.warnedAtCapacity) {
        this.warnedAtCapacity = true
        Logger.forRequest().warn({ maxPending }, "visit queue full; dropping analytics event")
      }
      return
    }
    this.logger.emit({
      eventName: "linq.visit",
      timestamp: new Date(),
      body: visit as unknown as AnyValue,
    })
  }

  /**
   * Waits for every visit already handed to `record`, including any recorded
   * while it waits.
   */
  flush(): Promise<void> {
    return this.exporter.forceFlush()
  }

  /**
   * Lists the raw log, newest first.
   *
   * @param q - The validated `GET /visits` query: filters and page.
   * @returns One page of visits and the total matching the filters.
   */
  async list(q: VisitListQuery) {
    const filters = FilterUtil.visitFilters(
      this.visitListQueryToVisitFilterQueryConverter.convertFrom(q),
    )
    // Page through narrow index entries before fetching full visit rows. A
    // deep offset must not sort or fetch millions of user-agent/query objects.
    const page = this.db
      .selectFrom("visits")
      .select(["id", "visited_at"])
      .where((eb) => eb.and(filters))
      .orderBy("visited_at", "desc")
      .orderBy("id", "desc")
      .limit(q.limit)
      .offset(q.offset)
      .as("page")
    const rows = await this.db
      .selectFrom(page)
      .innerJoin("visits", "visits.id", "page.id")
      .selectAll("visits")
      .orderBy("page.visited_at", "desc")
      .orderBy("page.id", "desc")
      .execute()
    const { total } = await this.db
      .selectFrom("visits")
      .select((eb) => eb.fn.countAll<number>().as("total"))
      .where((eb) => eb.and(filters))
      .executeTakeFirstOrThrow()
    return { data: rows.map((row) => this.visitRowToVisitConverter.convertFrom(row)), total }
  }
}

/**
 * The end of the visit pipeline: an OpenTelemetry log exporter whose "backend"
 * is the `visits` table. Each record's body is one visit; exporting it is the
 * INSERT. The rollup trigger then runs exactly as for any other insert.
 *
 * `SimpleLogRecordProcessor` calls `export` synchronously from `emit`, one record
 * at a time, so a visit is written the moment it arrives, still inside the
 * redirect request's async scope (which is what lets `Logger.forRequest()` below correlate a
 * failure to it). The processor's own `forceFlush` does not wait on exports, so
 * in-flight inserts are tracked here, and this exporter's `forceFlush` drains them.
 */
class VisitTableExporter implements LogRecordExporter {
  private readonly logRecordToVisitInsertConverter: LogRecordToVisitInsertConverter

  /** In-flight inserts, so a shutdown or a test can wait for them. */
  private readonly pending = new Set<Promise<void>>()

  /**
   * @param db - The database visits are inserted into.
   * @param onSettled - Called after each insert settles, successful or not.
   */
  constructor(
    private readonly db: Db,
    private readonly onSettled: () => void,
  ) {
    this.logRecordToVisitInsertConverter = new LogRecordToVisitInsertConverter()
  }

  /** How many inserts are still in flight; what `VisitService.record`'s cap counts. */
  get inFlight(): number {
    return this.pending.size
  }

  export(records: ReadableLogRecord[], done: (result: ExportResult) => void): void {
    const rows = records.map((record) => this.logRecordToVisitInsertConverter.convertFrom(record))
    const first = rows[0]
    const write = async () => {
      try {
        await this.insertVisits(rows)
        done({ code: ExportResultCode.SUCCESS })
      } catch (error) {
        // Logged here, once, with the request's context. The processor hands the
        // failure to OpenTelemetry's global error handler, which is silent unless
        // a diag logger is installed.
        Logger.forRequest().error(
          { err: error, link_id: first?.link_id ?? null },
          "visit insert failed",
        )
        done({ code: ExportResultCode.FAILED, error: error as Error })
      } finally {
        this.pending.delete(insert)
        this.onSettled()
      }
    }
    const insert = write()
    this.pending.add(insert)
  }

  async forceFlush(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending])
  }

  shutdown(): Promise<void> {
    return this.forceFlush()
  }

  @Log("visit.record", {
    in: (rows: ReturnType<LogRecordToVisitInsertConverter["convertFrom"]>[]) => ({
      link_id: rows[0]?.link_id ?? null,
      domain_id: rows[0]?.domain_id,
      slug: rows[0]?.slug_requested,
    }),
  })
  private async insertVisits(rows: ReturnType<LogRecordToVisitInsertConverter["convertFrom"]>[]) {
    return this.db.insertInto("visits").values(rows).execute()
  }
}
