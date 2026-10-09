# 0007 – Visit counts are rolled up by trigger

**Status**: accepted · 2026-09-17

Supersedes the counting strategy settled in the first plan: "SQL aggregates over
`clicks` with proper indexes. No materialized views, no denormalised counters."

## Context

Every number linq reports was a live aggregate over the whole visits table. That
held while the table was small, and stopped holding in two places at once:

- Every link list and link detail response left-joined a `count(*) … group by
  link_id` over all visits, with no date bound, to show each link's totals and to
  order `?sort=visits`. The most-visited page in the UI ran the most expensive
  query in it.
- The charts grouped an unbounded table by day, country, referrer and four other
  dimensions on every panel change.

A materialized view would have to be refreshed, which means either a cron with a
staleness window or a lock on the read path, and `REFRESH` re-reads everything to
change very little.

## Decision

Two derived tables, written only by triggers on the visits table, in the same
transaction as the visit that caused them:

- `visit_days` — one row per `(day, domain, link, dimension, value, bot)`, where
  `dimension` is `total` or one of the six the stats API groups by. One table
  serves every grouping.
- `visit_counts` — one row per link, plus one per domain for its orphans,
  carrying all-time human and bot totals and the last visit's timestamp.

The trigger **increments**; it does not recompute the day. A recompute would be
self-healing but would re-aggregate a whole day on every hit, which is the cost
this decision exists to avoid.

Purging a link destroys its rollup rows outright, in the same trigger that
runs on `links`' `AFTER DELETE`. It has to: `visits.link_id` is
`ON DELETE CASCADE`, so purge already destroys the link's own visits, and the
rollups must always equal a live aggregate over `visits` — leaving rollup rows
behind, orphaned or not, would break that equivalence the moment the visits
they summarize are gone. Purging a domain takes its rollups with it by
cascade, as it already takes its visits.

Because the rollup's grain is a day, the stats API takes `from` and `to` as
dates rather than timestamps. The raw visit log still filters on timestamps and
still reads the detail table.

## Consequences

- Both rollup tables are derived data. Only the triggers may write them, and
  anything that ever deletes or rewrites visits in bulk — a retention job, a
  hand-run `DELETE` — has to go through a trigger or a recount, or the numbers
  silently drift. There is no such job today.
- One visit now writes eight rows instead of one. It is off the response path,
  since visits are inserted fire-and-forget, but a burst costs eight times the
  write work. If that becomes the bottleneck, the lever is dropping the
  high-cardinality dimensions — referrer, destination, slug — from the trigger
  and serving those three live.
- Stats windows are day-grained and cut in UTC. An hour-scoped report is no
  longer possible without reading the detail table.
- The rollups can be rebuilt from `visits` at any time; the backfill in
  `0005_visit_rollup_triggers.sql` is that procedure.
- `visit_days`'s uniqueness is `NULLS NOT DISTINCT`, so the orphan scope upserts
  onto one row rather than inserting a new one per visit. That raises the
  Postgres floor to 15.
