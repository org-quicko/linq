# linq — Plan 4: the geo database as an external cache

Follows `plans/Plan_3.md`, which is implemented.

> **Status: implemented.** 204 server tests pass; `tsc -b --force`, `biome check .`
> and the admin build are all exit 0. Three deviations, all small:
>
> - The boot line carries `ready: reader !== null` as well as `source` and `path`.
> Without it `geo: ready` would print after a failed open and say the opposite of
> what happened.
> - `.env.example`'s rotation comment said "the same volume as the GeoLite2
> database" — stale twice over. It now describes the data volume as log-only.
> - The `config.ts` transform comment claimed the log file lives under the data
> volume "for the same reason the geolocation database does", which is exactly the
> reasoning this plan undoes. Rewritten to name the durable/regenerable split.
>
> The `docker compose up` check is **not** done: no Docker on this machine. That
> `/data` holds only `logs/` and `/geo` the `.mmdb` rests on `LINQ_GEO_DIR=/geo`
> in the image plus the test asserting the download lands in `LINQ_GEO_DIR` and
> not in `LINQ_DATA_DIR`. It is milestone-8 work either way.

## Context

The stated worry — the geolocation database inflating the Docker image — is
already handled, and that was checked before planning around it. The Dockerfile
has no `COPY` of any `.mmdb`, `.dockerignore` excludes `data`, and the file is
fetched at boot into `LINQ_DATA_DIR`, which the image sets to `/data` and
declares as a `VOLUME` (`Dockerfile:24,42`). The image carries zero bytes of
DB-IP.

What is genuinely wrong is one level down. `LINQ_DATA_DIR` has exactly two
consumers: the geo database (`apps/server/src/clicks/geo.ts:38`) and the rotating
log file (`apps/server/src/config.ts:30`). So one volume holds an 8 MB
**regenerable cache** next to the only **durable** thing linq writes to disk. An
operator backing up `/data` backs up a file they could re-download; an operator
sizing `/data` sizes it for both.

Two smaller gaps fall out of the same area:

- An operator with restricted egress or an air gap has one option today,
  `LINQ_GEO_ENABLED=false`, which loses country entirely. There is no way to hand
  linq a database it already has.
- Refresh is driven by a 30-day staleness check (`geo.ts:8`), but DB-IP publishes
  monthly. A copy downloaded on the 2nd is not replaced until the 2nd of the
  following month, so a whole publication cycle can be missed.

linq has never shipped — one commit, `ed6e47b Initial commit`, and Plan 1's
milestone 8 is still blocked — so there are no live `/data` volumes to migrate
and no orphaned `.mmdb` to clean up.

---

## 1. Three knobs, one precedence rule

| Variable | Default | Meaning |
|---|---|---|
| `LINQ_GEO_ENABLED` | `true` | Master switch. `false` means no lookup at all. |
| `LINQ_GEO_DB_PATH` | unset | Read this file; never download, never manage it. |
| `LINQ_GEO_DIR` | `LINQ_DATA_DIR` (code), `/geo` (image) | Where linq's *own* download lands. |

**`LINQ_GEO_ENABLED=false` wins over everything.** The two are not on the same
axis: `ENABLED` decides whether geo runs, `DB_PATH` decides where the data comes
from. Most-specific-wins is the right rule for two settings on one axis; applying
it across axes is what turns a switch named `ENABLED` into one that does not
disable — and that switch is what an operator reaches for under pressure.

```
ENABLED=false                → noGeo, whatever else is set
ENABLED=true,  DB_PATH set   → read that file, never fetch, never expire it
ENABLED=true,  no DB_PATH    → download into GEO_DIR, refresh when stale
```

The rule is stated once, in `config.ts`, and `startGeo` reads it.

`apps/server/src/config.ts` — two new keys beside `LINQ_GEO_ENABLED:13`, and one
line in the existing `.transform` that already defaults `LINQ_LOG_FILE`:

```ts
LINQ_GEO_DIR: z.string().optional(),
LINQ_GEO_DB_PATH: z.string().trim().min(1).optional(),
// …in the transform, beside LINQ_LOG_FILE:
LINQ_GEO_DIR: c.LINQ_GEO_DIR ?? c.LINQ_DATA_DIR,
```

## 2. `startGeo` barely changes

`apps/server/src/clicks/geo.ts` keeps its shape. A supplied path skips the
staleness check and the download, and nothing else moves:

- `const supplied = config.LINQ_GEO_DB_PATH`
- `path` becomes ``supplied ?? join(config.LINQ_GEO_DIR, `${EDITION}.mmdb`)``
- inside `refresh`, the download is guarded: `if (!supplied && (await isStale(path)))`
- `STALE_AFTER_MS` 30 days → **7 days**, so a new monthly file is picked up
  within a week and staleness is bounded at ~5 weeks rather than ~9

**The 24 h timer keeps running in both modes.** For a supplied path it re-opens
the reader, so an operator who drops in a newer file gets it live within a day
without a restart — and that is *less* code than branching around the timer.

**A bad `LINQ_GEO_DB_PATH` degrades, it does not exit.** The existing
`try`/`catch` in `refresh` already logs and swallows; a missing supplied file
lands there like any other failure. This keeps ADR 0004's invariant — location is
a nice-to-have and never keeps the server from serving — and means an NFS blip on
restart cannot take redirects down.

One line is added, at `info`, naming which mode won:

```ts
log.info({ source: supplied ? "supplied" : "download", path }, "geo: ready")
```

The span's `in` only logs at debug, and the default level is `info`, so without
this an operator has no way to tell from the logs which file is in use.

## 3. The volume split

- `Dockerfile` — `ENV LINQ_GEO_DIR=/geo` beside the existing `LINQ_DATA_DIR=/data`
  (`:23-24`), and a second `VOLUME /geo` beside `VOLUME /data` (`:42`).
- `docker-compose.example.yml` — mount `linq-geo:/geo` beside `linq-data:/data`
  (`:36-37`), declare `linq-geo:` under `volumes:` (`:39-41`), and carry a
  commented `LINQ_GEO_DB_PATH` example showing a read-only bind mount.
- `.env.example` — replace the single `LINQ_GEO_ENABLED` entry with the three,
  and correct the "Where the geolocation database and the log file are stored"
  comment on `LINQ_DATA_DIR`, which stops being true.

Local development is untouched: the code default falls back to `LINQ_DATA_DIR`,
so `./data` still holds both and `.gitignore`'s `data/` still covers it.

## 4. Documentation

**New `docs/adr/0005-geo-database-is-an-external-cache.md`.** It clears all three
bars: the volume layout is awkward to change once operators have deployments,
a reader will ask why geolocation has its own volume when nothing else does, and
it is a real trade — a second volume to mount in exchange for a `/data` that is
worth backing up. It records the precedence rule, why `ENABLED` wins, that a
supplied database is the operator's to manage including its freshness, and the
7-day staleness bound.

**`docs/adr/0004`** keeps the vendor decision and gains a pointer line to 0005,
the way `Plan_1.md` points at `Plan_2.md`. Its `LINQ_GEO_ENABLED` sentence is
still true and needs no amendment.

**`CONTEXT.md` — no change.** The geo database is infrastructure, not ubiquitous
language; the glossary is terms only, and neither a volume nor an env var belongs
in it. Click already carries *country*, which is the domain concept.

## Sequencing

1. `config.ts`, then `geo.ts` — the whole behaviour change, ~10 lines.
2. Tests.
3. `Dockerfile`, compose, `.env.example`.
4. ADR 0005 and the 0004 pointer.

## Verification

```bash
bun test apps/server/test      # 201 existing stay green
bunx tsc -b --force            # exit 0
bunx biome check .             # exit 0 — check the exit code, not the tail
bun --filter @linq/admin build
```

`apps/server/test/helpers/db.ts` — `testConfig` gains `LINQ_GEO_DIR: "./data"`
and `LINQ_GEO_DB_PATH: undefined`. It already sets `LINQ_GEO_ENABLED: false`, so
no suite reaches the network.

`apps/server/test/geo.test.ts` — the three existing tests move from
`LINQ_DATA_DIR` to `LINQ_GEO_DIR`, which is itself the assertion that the
download stopped landing in the data directory. New tests, each stubbing `fetch`
the way the file already does:

- a supplied path is read and **`fetch` is never called** (`seen` stays empty)
- `ENABLED=false` with `DB_PATH` set yields `noGeo` — the precedence rule, which
  is the one thing here a future reader would get backwards
- a supplied path that does not exist leaves a working `lookup` returning nulls,
  and `startGeo` does not throw
- with no `DB_PATH`, the file lands under `LINQ_GEO_DIR` and **not** under
  `LINQ_DATA_DIR` when the two differ

Then one manual check, since no test can prove it: `docker compose up` with the
example file and confirm `/data` holds only `logs/` while `/geo` holds the
`.mmdb`. This is the milestone-8 Docker work, still blocked on this machine —
flag it as unverified rather than claim it.

## Risks

- **`ENABLED` and `DB_PATH` overlap in an operator's head**, whichever way
  precedence runs. The `info` line naming the winning mode is the mitigation, and
  the reason it is not debug-level.
- **A supplied database never expires.** An operator who mounts a file and forgets
  it will be routing on year-old country data with nothing warning them. That is
  the deal `DB_PATH` offers, and ADR 0005 says so explicitly.
- **Two volumes is one more thing to get wrong.** An operator who mounts `/data`
  and not `/geo` re-downloads 4 MB on every restart — harmless, and quieter than
  the failure it replaces.
