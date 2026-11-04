import type { Insertable } from "kysely"
import { ExportResultCode, type ExportResult } from "@opentelemetry/core"
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs"
import type { Config } from "../config.ts"
import type { Db } from "../db/client.ts"
import type { DB } from "../db/types.generated.ts"
import { log, reqLog, span } from "../log.ts"

export type VisitInput = Omit<Insertable<DB["visits"]>, "id" | "occurred_at">

type VisitRow = Insertable<DB["visits"]>

type VisitSettings = Pick<Config, "LINQ_VISIT_MAX_PENDING" | "LINQ_VISIT_BATCH_SIZE">

/**
 * Writes each batch the OTel processor hands it as one multi-row INSERT. See
 * resources/docs/adr/0022.
 *
 * Rows are sorted first so concurrent batches take the rollup triggers' row
 * locks in the same order (resources/docs/adr/0007). A batch that fails is
 * retried one row at a time, so one bad row costs that row, not its batch.
 *
 * Always reports success: every row has been written or logged by the time
 * the callback runs, and the processor has nothing better to do with a failure.
 */
class PostgresVisitExporter implements LogRecordExporter {
  constructor(
    private readonly db: Db,
    private readonly settled: (count: number) => void,
  ) {}

  export(records: ReadableLogRecord[], done: (result: ExportResult) => void): void {
    const rows = records
      .map((r) => r.body as unknown as VisitRow)
      .sort(
        (a, b) =>
          (a.domain_id ?? "").localeCompare(b.domain_id ?? "") ||
          (a.link_id ?? "").localeCompare(b.link_id ?? ""),
      )

    void this.write(rows).finally(() => {
      this.settled(rows.length)
      done({ code: ExportResultCode.SUCCESS })
    })
  }

  private async write(rows: VisitRow[]): Promise<void> {
    try {
      await span("visit.record", () => this.db.insertInto("visits").values(rows).execute(), {
        in: { rows: rows.length },
        level: "debug",
      })
      return
    } catch (err) {
      log.warn({ err, rows: rows.length }, "visit batch insert failed; retrying row by row")
    }

    for (const row of rows) {
      try {
        await this.db.insertInto("visits").values(row).execute()
      } catch (err) {
        log.error({ err, link_id: row.link_id ?? null }, "visit insert failed")
      }
    }
  }

  forceFlush = async () => {}
  shutdown = async () => {}
}

/**
 * One OTel pipeline per database handle. Production has exactly one; the test
 * suite opens a PGlite database per file, and a single global pipeline would
 * write every suite's visits into whichever database it saw first.
 */
type Pipeline = {
  provider: LoggerProvider
  emit: (row: VisitRow) => void
  /** Visits emitted and not yet written or given up on. */
  pending: number
  maxPending: number
  warnedAtCapacity: boolean
}

const pipelines = new Map<Db, Pipeline>()

function pipelineFor(db: Db, settings: VisitSettings): Pipeline {
  const existing = pipelines.get(db)
  if (existing) return existing

  const exporter = new PostgresVisitExporter(db, (count) => {
    pipeline.pending -= count
    if (pipeline.pending < pipeline.maxPending) pipeline.warnedAtCapacity = false
  })
  // Its own provider, never the global one: visits are data, and nothing else
  // in the process should be able to emit into this pipeline.
  const provider = new LoggerProvider({
    processors: [
      new BatchLogRecordProcessor({
        exporter,
        // Never reached: `recordVisit` stops emitting at the same cap first,
        // because the processor drops silently and linq warns.
        maxQueueSize: settings.LINQ_VISIT_MAX_PENDING,
        maxExportBatchSize: settings.LINQ_VISIT_BATCH_SIZE,
        // No waiting to fill a batch: a visit is written as soon as no insert
        // is running. A batch is only what arrived while the previous insert
        // was still running.
        scheduledDelayMillis: 0,
      }),
    ],
  })
  const logger = provider.getLogger("linq.visits")

  const pipeline: Pipeline = {
    provider,
    emit: (row) => logger.emit({ eventName: "linq.visit", body: row as never }),
    pending: 0,
    maxPending: settings.LINQ_VISIT_MAX_PENDING,
    warnedAtCapacity: false,
  }
  pipelines.set(db, pipeline)
  return pipeline
}

/**
 * Fire-and-forget on purpose: a visit must never delay a redirect, and a failed
 * insert must never turn a working link into an error.
 *
 * `id` and `occurred_at` are stamped here, not by the database: a visit may
 * wait behind a running insert, and a batch is one statement, so the column
 * default would both lag the request and give a whole batch one time.
 */
export function recordVisit(db: Db, visit: VisitInput, settings: VisitSettings): void {
  const pipeline = pipelineFor(db, settings)

  // Visits enrich analytics but must never let a traffic spike build an
  // unbounded backlog. Resume recording once the backlog drains below the cap.
  if (pipeline.pending >= pipeline.maxPending) {
    if (!pipeline.warnedAtCapacity) {
      pipeline.warnedAtCapacity = true
      reqLog().warn({ maxPending: pipeline.maxPending }, "visit queue full; dropping analytics event")
    }
    return
  }

  pipeline.pending++
  pipeline.emit({ id: Bun.randomUUIDv7(), occurred_at: new Date(), ...visit })
}

/** Waits for every visit already handed to `recordVisit` to be written. */
export async function flushVisits(): Promise<void> {
  for (const pipeline of pipelines.values()) {
    while (pipeline.pending > 0) {
      await pipeline.provider.forceFlush()
      // forceFlush returns early while another flush is mid-way; yield to the
      // event loop so that flush's insert can actually complete.
      if (pipeline.pending > 0) await Bun.sleep(1)
    }
  }
}
