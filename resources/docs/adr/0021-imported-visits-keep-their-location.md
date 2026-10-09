# 0021 – Imported visits keep their location

**Status**: accepted · 2026-10-09

## Context

[0010](./0010-no-geolocation.md) removed geolocation and dropped
`visits.country` and `visits.region`, leaving nothing behind for it. That holds
for every visit linq records itself.

Imported data is another kind of visit. It is history whose location was
resolved before it reached linq. Without a column to hold it, an import has to
throw away country and region for every past visit. That is data the operator
already has, not something linq would have to look up.

## Decision

`visits` gets two plain nullable columns, `country` (ISO 3166-1 alpha-2) and
`region` (a region name), in migration `0007`. Only imported data fills them.

linq does not capture them at ingest yet:

- No lookup, database file, vendor or header is read. A visit linq records
  leaves both columns null.
- No `country` Rule Condition comes back.
- No rollup dimension, `groupBy` value, index or API field is added. The
  columns are stored, not reported.

## Consequences

- Until capture exists, the columns are null for every visit linq records, so
  their coverage ends where the imported data ends. Any report built on them
  has to say so rather than read a falling share of non-null rows as a drop in
  traffic.
- linq may start capturing country and region at ingest, and may start storing
  the client IP. Capture would fill these same columns, so no further schema
  change is needed for location. Either step is its own decision. Location
  capture re-decides 0004/0005 under 0010's constraint, and storing the IP
  revisits [0001](./0001-clicks-never-store-client-ip.md). These columns do not
  pre-approve either.
- Reporting on them means a new rollup dimension, a `visits_analytics_idx`
  rebuild and API fields. That should come with capture, not before, so
  imported history does not quietly become a half-working feature.
