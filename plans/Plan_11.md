# linq — Plan 11: Redis-backed redirects, Visits, and day-wise rollups

Follows `plans/Plan_10.md`.

## Context

`plans/Plan_1.md:60` settled the counting strategy as "SQL aggregates over
`clicks` with proper indexes. No materialized views, no denormalised counters.
Counting strategy to be revisited by the user later." This plan is that revisit,
and it changes that decision.

Three things force it:

1. **Every read of the links list runs a full aggregate over the whole click
   table.** `apps/server/src/http/api/links.ts:68-93` builds a `click_totals`
   subquery — `count(*) filter (…) … group by link_id` with no date bound — and
   left-joins it onto *every* link list and link detail response, with
   `?sort=clicks` ordering on it (`links.ts:92`). This degrades before the charts
   do, and it degrades on the most-visited page in the UI.
2. **The redirect hot path is 2–3 uncached database round trips** —
   `findActiveDomain` (`apps/server/src/http/redirect.ts:20`), `findActiveLink`
   (`:43`) and `listRules` (`apps/server/src/rules/store.ts:13`) — on a path
   whose whole job is to answer in single-digit milliseconds. There is no cache
   layer anywhere in the server today.
3. **There is no way to browse the raw visit log.** The only listing is
   `GET /api/v1/links/:id/clicks` (`apps/server/src/http/api/clicks.ts:52`),
   surfaced as a non-paginated "Recent clicks" card capped at 25 rows
   (`apps/client/lib/store/links.ts:39`, `apps/client/app/links/detail/page.tsx:284`).
   Nothing shows the log across links, and orphan traffic has a chart but no rows.

The outcome: a `visits` detail table with a paginated browser in the UI, two
rollup tables kept exact by database triggers that serve every count and every
chart, and Redis in front of the redirect so a hit resolves without touching
Postgres. `Click` becomes `Visit` throughout, which is the name the domain
language should have had.

## Decisions taken with the user

- **Rename `Click` → `Visit` everywhere** — table, routes, shared types, UI
  copy, glossary.
- **Rollups are maintained by Postgres triggers on the detail table**, in the
  same transaction as the insert. Not a worker, not a queue, not a view.
- **Day-wise grain is one row per `(day, domain, link, dimension, value, bot)`**
  — one table serving all seven groupings.
- **Redis is required.** The server refuses to boot without it.

---

## 1. Rename Click → Visit

Mechanical, no behaviour change, done first and on its own so the rest of the
plan reads against the new names. Follows the precedent of
`apps/server/drizzle/0002_linqs_to_links.sql`.

| From | To |
|---|---|
| `clicks` table, `clicks_*_idx` | `visits`, `visits_*_idx` (column names unchanged) |
| `apps/server/src/clicks/*` | `apps/server/src/visits/*` (`bot.ts`, `geo.ts`, `platform.ts`, `record.ts`) |
| `recordClick`, `flushClicks`, `ClickInput` | `recordVisit`, `flushVisits`, `VisitInput` |
| `packages/shared/src/clicks.ts` | `packages/shared/src/visits.ts` |
| `Click`, `clickListQuerySchema`, `clickFilters` | `Visit`, `visitListQuerySchema`, `visitFilters` |
| `Link.humanClicks` / `botClicks` | `Link.humanVisits` / `botVisits` |
| `?sort=clicks` | `?sort=visits` |
| UI: "Clicks", "Recent clicks", "No clicks yet." | "Visits", "Recent visits", "No visits yet." |

- Migration `0003_clicks_to_visits.sql` — **generated**, never hand-written
  (`bun run db:generate`; the `drizzle/meta/*_snapshot.json` must stay in sync).
  Answer drizzle-kit's prompt as a *rename*, not drop/create, or the data is lost.
- `CONTEXT.md:11-12,21-22` — `Click` → `Visit`, `Orphan Click` → `Orphan Visit`.
- `docs/adr/0001`, `0002`, `0003` keep their wording. They are dated records of
  decisions that have not changed, and `plans/Plan_10.md:32` already set the
  precedent that ADRs and old plans are frozen. The glossary is the live
  document.

## 2. Redis on the redirect path

**No new dependency.** The runtime is Bun 1.4, which ships a Redis client
(`new RedisClient(url)`), exactly as `apps/server/src/db/client.ts:13` already
uses Bun's built-in Postgres client instead of a userland driver.

`apps/server/src/cache.ts` mirrors the shape of `apps/server/src/visits/geo.ts`
— the repo's established pattern for an injected external dependency:

```ts
export type Cache = {
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>
  del(...keys: string[]): Promise<void>
  stop(): void
}
export const noCache: Cache = { … }              // like `noGeo`, geo.ts:23
export async function startCache(config): Promise<Cache>
```

Values are JSON. **Every cache error is logged and swallowed** — `LINQ_REDIS_URL`
being required at boot must not mean that a Redis blip at 3am turns every
redirect into a 500; a failed `get` is a miss, a failed `del` is covered by the
TTL. Wired through `AppDeps` (`apps/server/src/http/app.ts:22`), `Env.Variables`
(`apps/server/src/http/env.ts:12`) and `main.ts` shutdown alongside `geo.stop()`.

**Two keys, both computable from the row that changed, so invalidation never
needs a `SCAN`:**

| Key | Value | Written by |
|---|---|---|
| `linq:domain:<host>` | `{ id, fallbackUrl }` or `null` | `findActiveDomain`, `redirect.ts:20` |
| `linq:target:<domainId>:<slug>` | `{ linkId, destination, forwardQuery, rules }` or `null` | `findActiveLink` + `listRules`, `redirect.ts:43` |

A cached `null` is a real answer (unknown host, unknown slug, archived link), so
a 404 flood costs one Postgres query per TTL rather than one per request.

Invalidation, on the mutation that causes it:

- `domains.ts` create / update / archive / restore / purge → `del linq:domain:<host>`.
- `links.ts` create / update / archive / restore / purge → `del linq:target:<domainId>:<slug>`.
  **Create must delete too** — it is what clears the negative entry for a slug
  that 404'd a moment ago.
- `rules.ts` `PUT /links/:id/rules` → same target key (rules are cached inside it).

TTL is `LINQ_CACHE_TTL`, default 300s, purely a backstop for an invalidation
that was missed.

Config, and the three places that must stay in step
(`apps/server/src/config.ts`, `.env.example`, `apps/server/test/helpers/db.ts:19`):

```
LINQ_REDIS_URL   z.string().min(1, "LINQ_REDIS_URL is required")   // no default
LINQ_CACHE_TTL   z.coerce.number().int().min(0).default(300)
```

`LINQ_REDIS_URL` can carry a password, so it goes into `collectSecrets`
(`apps/server/src/log.ts:63`) next to `DATABASE_URL` or it lands in
`data/logs/linq.log`.

`docker-compose.example.yml` gains a `redis:8` service with a `redis-cli ping`
healthcheck and a `depends_on: condition: service_healthy` on `linq`, matching
how `postgres` is already wired (`docker-compose.example.yml:19-22`).

The test suite stays Redis-free: `createApp` defaults `cache = noCache` exactly
as it defaults `geo = noGeo` (`app.ts:28`). Cache behaviour gets its own suite
driving a fake in-memory `Cache`.

## 3. The rollup tables

Added to `apps/server/src/db/schema.ts`. Both are derived data: `visits` remains
the only source of truth.

```
visit_dimension enum: total | country | region | platform | referer | destination | slug

visit_days    day date · domain_id uuid → domains cascade · link_id uuid null
              · dimension visit_dimension · value text · is_bot bool · count bigint
              UNIQUE (day, domain_id, link_id, dimension, value, is_bot) NULLS NOT DISTINCT
              INDEX (link_id, dimension, day) · INDEX (domain_id, dimension, day)

visit_counts  domain_id uuid → domains cascade · link_id uuid null
              · human bigint · bot bigint · last_visit_at timestamptz
              UNIQUE (domain_id, link_id) NULLS NOT DISTINCT
              INDEX (link_id)
```

Four things about that shape are deliberate:

- **`dimension = 'total'` (value `''`) exists** so `groupBy=day` reads one
  explicit dimension. Summing `platform` instead would give the same number
  today and silently stop doing so the first time a dimension becomes optional.
- **`link_id` is nullable with no foreign key.** Null is an orphan visit, matching
  `visits.link_id`. There is no FK because `ON DELETE SET NULL` firing on a purge
  would collide two rollup rows on the unique index; §4's trigger merges them
  instead. `domain_id` *does* cascade, which is what makes purging a domain
  destroy its rollups with its visits (`docs/adr/0002:29`).
- **`NULLS NOT DISTINCT` requires Postgres 15+.** `README.md` currently says 14+;
  update it. The compose file is already on 17 and PGlite 0.3 is on 17.
- **`value` is `''` where the dimension was null**, matching the existing
  `coalesce(…, '')` convention in `apps/server/src/http/api/stats.ts:33-41` and
  the client's "(not recorded)" label (`stats-panel.tsx:117`).

## 4. Triggers

One custom migration (`bunx drizzle-kit generate --custom`, so the journal entry
is written for us) holding two functions, two triggers and the backfill.

**`record_visit_rollup` — `AFTER INSERT ON visits FOR EACH ROW`.** Increments,
does not recompute:

```sql
d := (new.occurred_at at time zone 'UTC')::date;   -- same UTC cut as stats.ts:31

insert into visit_days (day, domain_id, link_id, dimension, value, is_bot, count)
select d, new.domain_id, new.link_id, dim, val, new.is_bot, 1
from (values ('total'::visit_dimension, ''),
             ('country',     coalesce(new.country, '')),
             ('region',      coalesce(new.region, '')),
             ('platform',    new.platform::text),
             ('referer',     coalesce(new.referer, '')),
             ('destination', coalesce(new.destination, '')),
             ('slug',        new.slug_requested)) as dims(dim, val)
on conflict (day, domain_id, link_id, dimension, value, is_bot)
  do update set count = visit_days.count + 1;

insert into visit_counts (…) values (…)
on conflict (domain_id, link_id) do update
  set human = visit_counts.human + excluded.human,
      bot   = visit_counts.bot   + excluded.bot,
      last_visit_at = greatest(visit_counts.last_visit_at, excluded.last_visit_at);
```

Seven upserts per visit, each an index lookup and an in-page update, inside a
transaction that is already off the response path — `recordVisit` is
fire-and-forget by contract (`apps/server/src/visits/record.ts:10-13`) and drained
by `flushVisits()` on shutdown (`main.ts:38`). That contract is unchanged: the
trigger rides the insert that already exists.

**`orphan_visit_rollups` — `AFTER DELETE ON links FOR EACH ROW`.** Purging a link
turns its visits into orphans via `ON DELETE SET NULL` (`schema.ts:114`,
`docs/adr/0002:28`); the rollups have to follow, set-based rather than row by row:

```sql
insert into visit_days (day, domain_id, link_id, dimension, value, is_bot, count)
select day, domain_id, null, dimension, value, is_bot, sum(count)
from visit_days where link_id = old.id
group by day, domain_id, dimension, value, is_bot
on conflict (…) do update set count = visit_days.count + excluded.count;
delete from visit_days where link_id = old.id;
-- and the same merge-then-delete for visit_counts
```

**Backfill**, in the same migration, so an existing install is correct the moment
it boots:

```sql
insert into visit_days …
select (occurred_at at time zone 'UTC')::date, domain_id, link_id, dim, val, is_bot, count(*)
from visits, lateral (values …) as dims(dim, val) group by 1,2,3,4,5,6;

insert into visit_counts (domain_id, link_id, human, bot, last_visit_at)
select domain_id, link_id, count(*) filter (where not is_bot),
       count(*) filter (where is_bot), max(occurred_at)
from visits group by domain_id, link_id;
```

Migrations run in-process at boot (`apps/server/src/db/migrate.ts:11`) and the
test suite runs the same files against PGlite (`test/helpers/db.ts:13`), so the
triggers are exercised by every existing test that records a visit — schema drift
and trigger bugs fail the suite, not the deploy.

## 5. Reads move onto the rollups

**Stats become day-grained, and only day-grained.** `statsQuerySchema`'s `from`
and `to` change from `z.iso.datetime()` to `z.iso.date()` (`YYYY-MM-DD`,
inclusive both ends, UTC). This is what removes the need for a second code path:
without it, the client's current `now - N days` timestamp
(`stats-panel.tsx:95-99`) never lands on a day boundary and every chart would
fall back to scanning `visits`. `visitListQuerySchema` keeps full datetimes — the
raw log is timestamp-grained and reads the detail table.

`aggregateVisits` (was `aggregateClicks`, `apps/server/src/http/api/stats.ts:56`)
keeps its signature and its ordering contract — days ascending, everything else
by volume descending — and swaps its source:

```ts
const dimension = groupBy === "day" ? "total" : groupBy
const key = groupBy === "day"
  ? sql<string>`to_char(${visitDays.day}, 'YYYY-MM-DD')`
  : visitDays.value
// sum(count) filter (where not is_bot) / filter (where is_bot)
```

It still emits no zero rows, so `fillDays` on the client (`stats-panel.tsx:49`)
keeps working unchanged. All three stats routes (`stats.ts:75`, `:96`, `:113`)
keep their shapes; only the `scope: SQL[]` they build now references `visitDays`.

**Link totals.** `linkQuery` (`apps/server/src/http/api/links.ts:68-93`) drops
the `click_totals` subquery entirely for a `leftJoin(visitCounts, eq(visitCounts.linkId, links.id))`,
with `?sort=visits` ordering on `coalesce(human,0) + coalesce(bot,0)`. This is the
single biggest win in the plan.

**One visits list route replaces the link-scoped one.**
`GET /api/v1/links/:id/clicks` (`apps/server/src/http/api/clicks.ts:52`) becomes
`GET /api/v1/visits`, taking `limit`/`offset` (`paginationSchema`,
`packages/shared/src/primitives.ts:46`), `from`/`to`/`bot` (the existing
`visitFilters`), plus `linkId`, `domainId` and `orphan=true` — the same three
scoping predicates `globalStatsRoutes` already builds (`stats.ts:119-120`).
Newest first, `{ data, total, limit, offset }`. One route, one client hook, one
test file; the link detail page passes `linkId` and the 404-on-unknown-link it
used to get from `loadLink` still comes from its own `getLink` query.

## 6. UI

- **New page `apps/client/app/visits/page.tsx`** — the paginated visit log:
  domain picker, orphan-only toggle, human/bot picker, range picker, table.
  Rows copy `ClicksCard` verbatim (`app/links/detail/page.tsx:317-338`) including
  the mandatory `<GeoAttribution/>` (`components/common.tsx:334`, ADR 0004).
  Nav entry goes in `NAV` (`components/app-shell.tsx:32`).
- **Extract `Pager` into `components/common.tsx`** from the one existing inline
  implementation (`app/links/page.tsx:216-240`) and use it on the links page, the
  visits page and the link detail card. Three call sites, one component — the
  same reasoning that produced `DataTable` (`common.tsx:184-188`).
- **Link detail's visits card** gains the pager and moves to the new endpoint;
  `getLinkClicks`'s hard-coded `limit: 25` with no offset
  (`lib/store/links.ts:39`) goes away.
- **`lib/store/visits.ts`** — `listVisits` endpoint, new `"Visit"` tag type on
  `apiSlice` (`lib/store/api.ts:38`).
- **Range moves to UTC dates.** `RANGES` (`stats-panel.tsx:31`) and the `from`
  computation move into `common.tsx` as a shared `useRange()` returning a
  `YYYY-MM-DD` string, so the chart and the list agree and both stay memo-stable.
  A date string changes once a day, which also permanently removes the
  refetch-loop footgun documented at `stats-panel.tsx:91-94`.

## 7. Records

- `docs/adr/0007` — visit counts are rolled up by trigger. It reverses
  `plans/Plan_1.md:60`; the consequence worth writing down is that the rollups are
  derived data that only the triggers may write, and that a day-grained rollup is
  why stats windows are dates and not timestamps.
- `docs/adr/0008` — Redis is required on the redirect path. Postgres stops being
  the only infrastructure linq needs; the trade is stated, along with the rule
  that a Redis failure degrades to Postgres rather than failing the request.
- `README.md` — Redis in the requirements, Postgres 15+, the renamed endpoints.

## Sequencing

Five commits, each green on its own:

1. **Rename.** Migration `0003`, no behaviour change. The whole existing suite
   must pass untouched apart from its own renames.
2. **Redis.** Cache module, config, invalidation, compose, ADR 0008.
3. **Rollups.** Schema, migration `0004`, trigger + backfill migration `0005`,
   ADR 0007. Nothing reads them yet, so the existing stats tests keep proving the
   live aggregates while the new suite proves the rollups agree with them.
4. **Reads.** Stats, link totals and the `/visits` route move over. This is the
   commit where a rollup bug becomes visible, which is why step 3 lands first.
5. **UI.** Visits page, `Pager`, shared range, nav.

## Verification

1. `bun install`, `bun run typecheck`, `bunx biome check .`, `bun test` — the full
   existing suite must stay green through every step above.
2. **Rollups agree with the truth.** New `apps/server/test/visits-rollup.test.ts`:
   record a spread of visits through the redirect handler, then assert
   `visit_days` and `visit_counts` equal a live `count(*) … group by` over
   `visits` for every dimension and both bot values. This is the test that would
   catch an increment that drifts.
3. **Purge.** Extend `apps/server/test/purge.test.ts`: purging a link moves its
   rollup rows to `link_id is null` with counts preserved and merged into any
   existing orphan rows; purging a domain removes its rollups by cascade.
4. **Stats are unchanged.** `apps/server/test/stats.test.ts` keeps its existing
   assertions and now reads through the rollup — if the two disagree, it fails.
5. **Cache.** New `apps/server/test/cache.test.ts` with a fake `Cache`: a second
   identical redirect issues no Postgres query; creating a link clears the
   negative entry for its slug; updating a link, editing its rules, and archiving
   or purging its domain each clear the right key; a `Cache` whose every method
   throws still redirects correctly.
6. **End to end.** `docker compose -f docker-compose.example.yml up`, then
   `curl -i localhost:3000/<slug>` twice — second hit shows no
   `link.findActive` span at `LINQ_LOG_LEVEL=debug`, and
   `redis-cli keys 'linq:*'` shows both keys. Then in `psql`:
   `select * from visit_counts` matches `select count(*) from visits`.
7. **UI.** `bun run dev` + `bun run dev:client`: the visits page paginates, the
   filters narrow, the range picker agrees with the chart above it, and the link
   detail card pages through more than 25 rows.

## Risks

- **Seven upserts per visit** is the cost of one table serving all seven
  groupings. It is off the response path, but a burst of traffic now writes eight
  rows per redirect instead of one. If that becomes the bottleneck, the lever is
  dropping the high-cardinality dimensions (`referer`, `destination`, `slug`) from
  the trigger and serving those three from `visits` live — the read path already
  knows which dimension it wants.
- **The rollups are only correct if nothing writes to `visits` behind the
  triggers' back.** Nothing does today, and nothing may. There is no retention or
  pruning job; when one is added, it must go through a delete trigger or a
  recount, not a bare `DELETE`.
- **Offset pagination over the visit log** degrades at depth, and so does its
  `count(*)`. Acceptable at current volumes and consistent with every other list
  in the API; the escape hatch if it bites is an id-keyset subquery, since ids are
  UUIDv7 and therefore time-ordered.
- **Redis becomes a hard boot dependency.** Mitigated by degrading to Postgres on
  any runtime cache error, but an operator who loses Redis permanently now has a
  server that will not start until they fix it or unset it.
- **`NULLS NOT DISTINCT` raises the Postgres floor to 15.** Anyone still on 14
  cannot take this upgrade.
