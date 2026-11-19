import type { VisitInput } from "@linq/shared"
import type { AnyValue, Logger as OtelLogger } from "@opentelemetry/api"
import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"
import type { Db } from "../../clients/index.ts"
import type { Config } from "../../config.ts"
import { Logger } from "../../libs/index.ts"
import { VisitTableExporter } from "./VisitTableExporter.ts"

/**
 * The OpenTelemetry side of visit recording: a `linq.visits` logger whose one
 * processor exports each record, as it is emitted, to `VisitTableExporter`,
 * which writes it to the `visits` table. See resources/docs/adr/0022.
 *
 * One instance per app owns that app's in-flight inserts, so `flush` drains
 * exactly this app's visits: what shutdown and the tests wait on.
 */
export class VisitPipeline {
  private readonly exporter: VisitTableExporter
  private readonly logger: OtelLogger
  private warnedAtCapacity = false

  /**
   * @param db - The database visits are written to.
   * @param config - LINQ_VISIT_MAX_PENDING, the most in-flight inserts before visits are dropped.
   */
  constructor(
    db: Db,
    private readonly config: Pick<Config, "LINQ_VISIT_MAX_PENDING">,
  ) {
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
   * Emits one visit as a log record; the exporter starts its insert before this
   * returns. Drops the visit instead when the cap is reached.
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
}
