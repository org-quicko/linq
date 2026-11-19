import { type ExportResult, ExportResultCode } from "@opentelemetry/core"
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs"
import type { Db } from "../../clients/index.ts"
import { LogRecordToVisitInsertConverter } from "../../converters/index.ts"
import { Log, Logger } from "../../libs/index.ts"

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
export class VisitTableExporter implements LogRecordExporter {
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

  /** How many inserts are still in flight; what `VisitPipeline.record`'s cap counts. */
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
