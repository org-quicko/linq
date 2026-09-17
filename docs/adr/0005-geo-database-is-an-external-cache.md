# 0005 – The geolocation database is an external cache

**Status**: superseded by [0010](./0010-no-geolocation.md) · 2026-09-15

Follows [0004](./0004-keyless-geolocation-database.md), which chose the vendor. This one is about where the file lives and who owns it.

## Context

`LINQ_DATA_DIR` had exactly two consumers: the geolocation database and the rotating log file. One volume therefore held an 8 MB **regenerable cache** beside the only **durable** thing linq writes to disk. An operator backing up `/data` backed up a file they could re-download at any time, and an operator sizing it sized it for both. The two have nothing in common except that neither is in Postgres.

The Docker image never carried the database — it is fetched at boot, and there is no `COPY` of any `.mmdb` — so image size was never the problem. The volume was.

Two gaps sat in the same area. An operator with restricted egress had one option, `LINQ_GEO_ENABLED=false`, which gives up country entirely; there was no way to hand linq a database it already had. And refresh ran on a 30-day staleness check against a file DB-IP publishes monthly, so a copy downloaded on the 2nd was not replaced until the 2nd of the following month — a whole publication cycle could pass unnoticed.

## Decision

The geolocation database is treated as a cache that linq owns but does not guard, configured by three variables:

| Variable | Default | Meaning |
|---|---|---|
| `LINQ_GEO_ENABLED` | `true` | Master switch. `false` means no lookup at all. |
| `LINQ_GEO_DB_PATH` | unset | Read this file. Never downloaded, never expired. |
| `LINQ_GEO_DIR` | `LINQ_DATA_DIR` in code, `/geo` in the image | Where linq's own download lands. |

**`LINQ_GEO_ENABLED=false` wins over everything, including a supplied path.** The two are not on one axis: `ENABLED` decides whether geolocation runs, `DB_PATH` decides where the data comes from. Most-specific-wins is the right rule for two settings on the same axis, and applying it across axes is what turns a switch named `ENABLED` into one that does not disable — which is the switch an operator reaches for under pressure.

The image declares a second `VOLUME /geo` and points `LINQ_GEO_DIR` at it, so `/data` holds only `logs/`. Local development is untouched: with `LINQ_GEO_DIR` unset the code falls back to `LINQ_DATA_DIR`, and `./data` still holds both.

**A supplied database is the operator's, freshness included.** linq opens it and nothing else — no download, no staleness check, no warning when it ages. The daily timer still runs and re-opens the reader, so dropping a newer file into place takes effect within a day without a restart.

**A missing or unreadable supplied path degrades; it does not exit.** It lands in the same `try`/`catch` as a failed download, and the server keeps serving with no country. ADR 0004's invariant holds: an NFS blip on restart must not be able to take redirects down.

Staleness for linq's own download drops from 30 days to **7**, so a new monthly file is picked up within a week and the copy in use is at most about five weeks old rather than nine.

One `info` line at boot names which mode won — `geo: ready` with `source` and `path` — because the span carrying that detail only logs at debug and the default level is `info`.

## Consequences

- `/data` becomes a volume worth backing up: everything in it is durable, and nothing in it is re-downloadable.
- **Two volumes is one more thing to get wrong.** An operator who mounts `/data` and forgets `/geo` re-downloads 4 MB on every restart. Harmless, and quieter than the failure it replaces.
- An air-gapped install can have country data for the first time, at the cost of owning the file.
- **A supplied database never expires.** An operator who mounts one and forgets it routes `country` Conditions on year-old data with nothing warning them. That is the deal `LINQ_GEO_DB_PATH` offers, stated here so it is not a surprise.
- `ENABLED` and `DB_PATH` still overlap in an operator's head whichever way precedence runs. The boot line naming the winning mode is the mitigation, and the reason it is not at debug.
- Nothing migrates: linq has not shipped, so there are no live volumes holding a database in the old place.
