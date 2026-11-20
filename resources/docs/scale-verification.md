# Local verification with four million visits

Verified on 2026-11-19 with Bun 1.4.2, PostgreSQL 18.6 and a production
Next.js static export on Windows. This is a functional and sequential latency
check on one local machine, not a concurrent-load or ingestion-throughput test.
The verification cluster, dummy records, local keys and scratch logs were
removed after the check. The scripts below recreate the fixture when needed.

## Results

The isolated `linq_scale` database initially contained exactly 4,000,000 visits:
3,200,000 human, 800,000 bot and 200,000 orphan visits. The fixture has 100
links, 90 UTC dates, three platforms, two browsers, device classes, locations
and campaign parameters. Browser/OS values use the lowercase form normal
ingestion writes.

Raw totals agreed with `visit_counts` and every one of the 13 daily rollup
dimensions. A real HTTP redirect subsequently inserted one human visit through
the normal OpenTelemetry exporter and enabled rollup trigger. Raw visits,
`visit_counts` and the daily total then all equalled 4,000,001.

The production client build passed. Browser verification used the UI at
`http://127.0.0.1:3000/home/` connected to `http://localhost:3000`, exercising
cross-origin API access. Checked:

- Add-server form, authentication, link listing and loading 25 more links.
- The 90-day dashboard: 4,000,001 total, 3,200,001 human, 800,000 bot,
  200,000 orphan; chart and source/device breakdowns rendered.
- Selecting Mobile: 2,666,667 matching visits.
- Adding the existing domain: HTTP 409 produced the toast
  “Could not add that domain.” and kept the dialog available for correction.

The API checks covered summary, timeseries, breakdown, a browser-filtered
detail query, first/intermediate/deep visit pages, link create/update/archive,
redirects, and 400/401/403/404/409 error envelopes. Selected sequential HTTP
observations after the pagination fix:

| Request | Observed time |
| --- | ---: |
| Summary | 51 ms |
| Timeseries | 5 ms |
| Platform breakdown | 5 ms |
| Chrome-filtered summary over the fixture range | 208 ms |
| Visits, limit 10, offset 0 | 215 ms |
| Visits, limit 10, offset 100,000 | 226 ms |
| Visits, limit 10, offset 3,999,990 | 828 ms |

These are single local observations, not percentile measurements or service
targets. Cache, storage, filters and hardware affect them.

Final regression checks passed: 334 server tests and 36 client tests,
typecheck, and Biome on the changed source, test and manual-check files.
The schema dump was refreshed from PostgreSQL 18.6. Code generation was also
run against the migrated database; the existing hand-tuned query types were
retained because this migration changes only an index.
Repository-wide `bun run lint` is not clean: it reports formatting (including
CRLF line endings), import-order, SVG accessibility and generated-types
diagnostics outside the focused pagination/manual-check files. These were
recorded separately from the passing focused Biome check.

## Issue found and fixed

The original raw visit list sorted full rows before applying its offset.
`EXPLAIN` showed a parallel sequential scan and full-row sort. Large pages
took 11.7–18.7 seconds and the HTTP client observed a connection reset.

Migration `0009_visit_pagination_index` adds `(visited_at DESC, id DESC)`.
`VisitService.list` first selects a page of IDs and timestamps, then joins to
fetch full rows only for that page. Ordering, filters, totals and the response
shape are preserved. A regression test covers equal timestamps, domain
filtering, successive pages and an empty page past the end. Offset pagination
still scans skipped index entries; this does not promise constant-time access
at arbitrary offsets or for every combination of filters.

The index builds transactionally during migration/startup. On an existing
large installation, allow deployment time for the build before accepting
traffic. Generated query types do not change for this index-only migration.

## Repeat the check

Run heavy operations **one at a time**: fixture loading, maintenance, client
build, API checks, browser checks, typecheck and test suite. Keep the app idle
while loading or maintaining its fixture database.

Use a dedicated PostgreSQL cluster bound only to `127.0.0.1:55441`, database
`linq_scale`, user `linq`. The manual scripts deliberately target only that
local address, not `DATABASE_URL`. They are run from the repository root.
For example, with PostgreSQL's `bin` directory on PATH, in PowerShell:

```powershell
initdb -D data/scale-check/postgres -U linq -A trust --no-locale --encoding=UTF8
pg_ctl -D data/scale-check/postgres -l data/scale-check/postgres.log -o '-h 127.0.0.1 -p 55441 -c shared_buffers=128MB -c max_connections=20' start
createdb -h 127.0.0.1 -p 55441 -U linq linq_scale
bun run apps/server/test/manual/seedScale.ts
bun run build:client
$env:DATABASE_URL = 'postgres://linq@127.0.0.1:55441/linq_scale'
$env:LINQ_DATA_DIR = 'data/scale-check'
bun run start
```

Local trust authentication is only for this loopback dummy cluster. Start it
without external exposure. In a second terminal, after startup completes:

```powershell
bun run apps/server/test/manual/checkScaleApi.ts
```

The API check expects a fresh four-million-row fixture and performs writes;
run it once per fresh fixture. It saves response/timing evidence to
`data/scale-check/api-results.json`. The local admin key is in the ignored
`data/scale-check/key.txt`; use it in the UI connection form. Never commit it.
The fixture, logs and local database files stay under ignored `data/`.

The bulk fixture loader temporarily disables only the insert rollup trigger,
then re-enables it and rebuilds aggregates sequentially. Do not serve traffic
until that finishes. If loading is forcibly interrupted, rerun the loader
before verification and confirm trigger/aggregate consistency. This setup
bypasses the normal ingestion pipeline for bulk fixture creation; the separate
real redirect proves normal ingestion and rollups still work.

An initial attempt to normalize all fixture rows in one transaction exhausted
PostgreSQL executor memory and rolled back. The recovery used 10,000-row
transactions, followed by `VACUUM (ANALYZE) visits`. The retained fixture loader
already writes normalized data, so this correction is not part of the repeat
procedure. Keep bulk fixture work bounded even when only one process runs.

After browser verification, close the verification tab, stop the API, then
stop this cluster (the data remains available):

```powershell
pg_ctl -D data/scale-check/postgres stop -m fast
```

To reclaim the fixture's disk space, first verify that this cluster is stopped
and that `data/scale-check` resolves inside this checkout, then remove that
directory. This deletes its database, local key and verification logs; keep
the reusable scripts and this report. It does not involve the machine's
existing PostgreSQL service or any other database.

Run `bun run typecheck` and `bun run test` sequentially for regression checks.
The automated tests use their own PGlite databases rather than these fixtures.
