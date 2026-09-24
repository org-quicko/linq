# 0015 – A filtered report reads the visit log

**Status**: accepted · 2026-09-22.

## Context

ADR 0007 made reports sums over `visit_days`: day-grained rows with exactly
one dimension value. That shape is cheap for an unfiltered report but cannot
express filters across dimensions. A report filtered to a referer and an OS,
for example, needs both facts from the same visit.

## Decision

Unfiltered analytics reports continue to read `visit_days`. Any report with a
`referer`, `os`, `browser`, or `platform` filter reads `visits` instead. Its
date window must have `from` and is capped at 366 days.

`visits_analytics_idx` covers every column a filtered report reads.
`referer_host` is a stored generated column, computed by the immutable SQL
`referer_host(text)` function, so referer filters and grouping can be covered
without an index expression. The rollup stores that host, rather than the full
referer URL.

On PostgreSQL 17 with 4,000,000 visits over 365 days, the normal 30-day
filtered timeseries used `Index Only Scan using visits_analytics_idx` (66,101
rows, `Heap Fetches: 0`, 333.992 ms); the filtered referer breakdown did too
(9,288 rows, `Heap Fetches: 0`, 41.827 ms). At a full-year window PostgreSQL
correctly chose `Parallel Seq Scan` instead: the timeseries read 100,059
buffers in 2,187.069 ms and the narrower breakdown read 100,059 buffers in
355.832 ms. The date cap bounds this intentionally near-table-wide case.

The default unfiltered 30-day referer breakdown used
`visit_days_dimension_day_idx`, then a `Parallel Bitmap Heap Scan` on
`visit_days`: 107,733 rows, 38,843 buffers read, 449.697 ms. It remains on the
rollup path; the high-cardinality referer dimension makes this bounded cost
preferable to scanning the raw log.

## Consequences

There are two read paths. The path-equivalence test keeps their bucket keys
and window semantics aligned. The one-year cap is load-bearing, and the
covering index adds one write per visit while consuming substantial storage.
Changing host extraction later requires a generated-column rewrite and a
rollup rebuild. Empty dimension values use `(none)` on the wire because an
empty CSV item cannot round-trip.

We rejected combination rollups: four filterable dimensions, two open-ended,
make their cardinality combinatorial. Separate btrees per dimension add more
writes to the redirect path; BRIN cannot provide the covering index-only
scan; an index expression prevents it; and TypeScript extraction duplicates a
SQL rule needed by the rollup rebuild. `destination` remains a full URL and
the high-cardinality dimension; `referer` is intentionally only its host.
