# 0022 – Visits are emitted as OpenTelemetry logs

**Status**: accepted · 2026-11-04.

## Context

Every redirect recorded its visit with its own fire-and-forget `INSERT`. The
redirect never awaited it, but every insert still took a connection from the
one `pg` pool the redirect lookups use, so a traffic spike put up to
`LINQ_VISIT_MAX_PENDING` single-row inserts in line ahead of the next
redirect's query. Each one also fired the rollup triggers (0007) in its own
transaction.

We also want the visit stream to be portable: today it lands in Postgres, but
moving it to a Collector or an analytics store later should not mean
rewriting the redirect.

## Decision

The redirect emits each visit as an OpenTelemetry log record into a
`LoggerProvider` private to `visits/record.ts`, never the global one. Its
`BatchLogRecordProcessor` queues records and hands them in batches to a
`PostgresVisitExporter` running in the same process. There is no Collector and
no network hop.

- **No holding back**: the processor's scheduled delay is 0. A visit is
  written as soon as no other visit insert is running; nothing waits to fill a
  batch. The processor runs one export at a time, so a batch is only the
  visits that arrived while the previous insert was running, up to
  `LINQ_VISIT_BATCH_SIZE` rows (default 100). A time-based flush window was
  considered and rejected: it would hold visits in memory for no reason when
  the database is idle, and widen what a crash loses.
- **Cap**: `LINQ_VISIT_MAX_PENDING` keeps its meaning, the most visits waiting
  on the database. `recordVisit` counts in-flight visits itself and stops
  emitting at the cap with one warning, because the processor drops silently.
- **Failures**: a batch that fails is retried one row at a time, so a bad row
  costs that row. A database that is down still loses the batch, as it lost
  the single insert before.
- **Lock order**: each batch is sorted by `(domain_id, link_id)` before the
  insert, so concurrent batches from several instances take the rollup rows'
  locks in the same order.
- **Timestamps**: `id` and `occurred_at` are set at emit time. The column
  default would lag a visit that waited behind a running insert, and give a
  whole batch one time.

The OTel packages (`@opentelemetry/api`, `core`, `sdk-logs`) are pinned to
exact versions.

## Consequences

- A crash or `kill -9` loses the visits in the running insert plus those
  queued behind it, the same order of loss as before. A clean shutdown drains
  the queue through `flushVisits()`.
- Visit inserts still share the redirect's pool, but one process now holds at
  most one connection for them at a time, where before a spike could take
  every connection in the pool. No connection is reserved for redirects.
- Under sustained load beyond what one insert at a time can write, the queue
  fills to `LINQ_VISIT_MAX_PENDING` and visits are dropped, as before.
- Moving visits elsewhere means replacing the exporter. The redirect and
  `recordVisit`'s callers do not change. Only Postgres is implemented today.
- This is not observability. No traces or metrics are exported, and nothing
  outside the process sees these records.
