# 0022 – Visits are written through an OpenTelemetry log pipeline

**Status**: accepted · 2026-11-15.

## Context

A redirect records one Visit. `recordVisit` (`services/VisitService.ts`) used to
issue the `INSERT INTO visits` itself: fire-and-forget, never awaited by the
redirect, tracked in an in-memory set of in-flight inserts so a shutdown could
drain them and so `LINQ_VISIT_MAX_PENDING` could drop visits instead of letting
a traffic spike build an unbounded backlog.

We want visits to travel as OpenTelemetry data on their way to the `visits`
table, in the same process and to the same database, with each visit written
the moment it arrives.

## Decision

Each visit is emitted as one OpenTelemetry **log record** (`eventName:
"linq.visit"`, the visit as its body, the click time as its timestamp) on a
`linq.visits` logger. That logger's provider has exactly one processor, a
`SimpleLogRecordProcessor`, and exactly one exporter, `VisitTableExporter`,
whose `export` is the `INSERT`. The rollup trigger (ADR 0007) then runs exactly
as for any other insert.

- **Written on arrival.** The Simple processor exports each record as it is
  emitted, one row per insert, with no queue or batching interval. Its call into
  the exporter is synchronous, so the insert starts inside the redirect
  request's async scope and a failure is logged against that request.
- **`visited_at` is the record's timestamp**, stamped at emit, not the
  database's `now()` at insert, so the column stays the click's time even if
  the export path ever introduces delay.
- **The cap and the drain are linq's, not the SDK's.** The Simple processor has
  no queue limit, and its `forceFlush` does not wait on exports in flight. The
  exporter therefore registers every insert in the same in-flight set as before:
  `LINQ_VISIT_MAX_PENDING` counts it and drops past it, and `flushVisits` waits
  on it at shutdown and in tests.
- **Failures are logged by the exporter.** It logs `visit insert failed` once,
  with the request's context, then reports `FAILED`. The SDK passes that to
  OpenTelemetry's global error handler, which stays silent unless a diag logger
  is installed, so nothing is logged twice.
- **One logger per database handle**, held in a `WeakMap`, so each PGlite
  test database gets its own pipeline and can still be garbage-collected.
- Dependencies: `@opentelemetry/api`, `@opentelemetry/core`,
  `@opentelemetry/sdk-logs`. No auto-instrumentation and no collector: the SDK
  is plain JavaScript and runs on Bun as is.

We did not route visits through an external OpenTelemetry Collector. The
collector has no standard exporter that writes rows into Postgres, so it would
need either a custom Go exporter built into a custom collector binary, or a
round trip back into a linq ingest endpoint. Either adds a second process and a
schema mapping to keep in sync with the trigger, between a click and its row.

We did not use `BatchLogRecordProcessor`. It would bound its own queue, but it
holds visits for a batching interval, and the requirement is to write each visit
as soon as it is received.

## Consequences

- No change to what a visit contains or where it lands: the same row, the same
  rollups, the same analytics. No IP address enters the log record, so none
  can reach the table (ADRs 0001 and 0003).
- The pipeline is still in memory. A crash loses in-flight inserts, as before;
  only a collector with a persistent queue would change that, and it is out of
  scope here.
- `LINQ_VISIT_MAX_PENDING` keeps its meaning and default (1,000 inserts in
  flight). It is now the only bound, since the Simple processor has none.
- Any further exporter on the `linq.visits` logger receives every visit's full
  body. One added for observability must not forward visits anywhere they
  should not be stored, and must never add client addresses.
- Moving to batched writes later is a processor swap
  (`BatchLogRecordProcessor`, whose `maxQueueSize` would then replace the cap)
  plus a multi-row insert, which the exporter already handles.
- `test/visit-pipeline.test.ts` holds the property the cap depends on: an
  emitted visit counts as in flight before `emit` returns.
