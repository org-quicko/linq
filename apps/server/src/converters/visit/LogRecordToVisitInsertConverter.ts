import type { VisitInput, VisitInsert } from "@linq/shared"
import { hrTimeToMilliseconds } from "@opentelemetry/core"
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs"

/**
 * Turns one OpenTelemetry visit log record into the `visits` row it is written as.
 *
 * @param record - A record emitted by `VisitPipeline.record`, whose body is a `VisitInput`.
 * @returns The row to insert, stamped with the click's own time rather than the insert's `now()`.
 */
export class LogRecordToVisitInsertConverter {
  convertFrom(record: ReadableLogRecord): VisitInsert {
    return {
      id: Bun.randomUUIDv7(),
      ...(record.body as unknown as VisitInput),
      visited_at: new Date(hrTimeToMilliseconds(record.hrTime)),
    }
  }
}
