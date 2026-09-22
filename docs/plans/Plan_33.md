# linq — Plan 33: a report API that filters

Follows `docs/plans/Plan_31.md` §A4 and §C3, which built the Analytics overview
and left its breakdown rows read-only.
`apps/client/components/analytics-overview.tsx:31-34` records the reason
verbatim:

> The mockup's per-row "click a breakdown row to filter the whole view by
> that segment" interaction needs a server-side filter (e.g. `referer=`) the
> stats endpoints don't accept today, so the rows here are read-only.

This plan builds that server-side filter. `docs/plans/Plan_34.md` spends it.

---

## Context

Analytics is meant to work by segment: pick a referrer, an OS, a browser or a
device type from a breakdown list and the whole report narrows to it — the
totals, the daily trend, and every *other* breakdown. Several such filters
have to stack, so "referrer is google.com **and** OS is windows" is one
question, not two.

Three things stand in the way, and all three are server-side:

1. **The rollup cannot answer it.** `visit_days` (ADR 0007) stores one row
   per `(day, domain, link, dimension, value, bot)`. A row knows one
   dimension's value and nothing about the others, so "OS breakdown where
   referer = google.com" is not a query that table can serve at any price.
   The assumption is baked into `apps/server/src/http/api/stats.ts:66`:
   `eq(visitDays.dimension, dimensionOf(group_by))`.
2. **The stats API has no filter surface at all.** `statsQuerySchema`
   (`packages/shared/src/visits.ts:54-58`) is `from`, `to`, `group_by`, and
   that is the whole of it.
3. **Referrers are stored raw.** `redirect.ts:252` records the entire
   `Referer` header, so a referrer breakdown lists full URLs — one bucket per
   distinct URL including its query string — and a filter would have to match
   one exactly.

## What's being built

1. An `IMMUTABLE` function `referer_host(text)` and a stored generated column
   `visits.referer_host` computed from it. The rollup trigger's `referer`
   dimension switches to the column, and so does every referrer filter.
   `visits.referer` keeps the full URL.
2. A covering index on `visits` carrying every column a filtered report
   reads, plus one index on `visit_days` for the default unfiltered view.
3. Three endpoints under `/api/v1/analytics/` — `summary`, `timeseries`,
   `breakdown` — sharing one filter vocabulary, reading the rollup when they
   can and the visit log when they must.
4. A one-year cap on the window, enforced where it bites.
5. `docs/adr/0015`, recording why a filtered report leaves the rollup.

**Explicitly not in this plan**: removing `/v1/stats`,
`/v1/links/:id/stats` or `/v1/domains/:id/stats`. The Client UI still calls
them, and they go in `docs/plans/Plan_34.md` once it no longer does. Two report
APIs coexist for exactly one plan's duration.

Also not in scope: geolocation of any kind — ADR 0001/0003/0010 stand and
nothing here reverses them; an hour grain; collapsing `destination` to a host
the way `referer` is collapsed (§H records why the asymmetry is deliberate).

**One visible behaviour change lands here, before the client is touched**:
`/v1/stats?group_by=referer` starts returning hosts instead of full URLs,
because it reads the same rollup rows the trigger now writes. The existing
Referrers card renders whatever it is given, so this shows up as the card
getting more readable, not as a break.

---

## A. Measurements this design is built on

Measured against **PGlite 17.5** (the engine the test harness runs) on a
seeded table of **300,000 visits spread over 365 days**, with
`enable_seqscan` turned back **on** — PGlite ships it off, which silently
flatters every plan. Table 62 MB, covering index 29 MB. Window 30 days
(24,659 rows), filter `os IN (2) AND referer_host IN (2)` (6,575 rows).

| plan | buffers | heap fetches |
|---|---|---|
| Bitmap Heap Scan, no covering index | 1,862 | ~1,738 blocks |
| Bitmap Heap Scan, covering index present | 1,678 | 1,369 blocks |
| **Index Only Scan** | **312** | **0** |

Buffer counts are what transfers to real Postgres; PGlite's *timings* do not,
because it is 32-bit WASM.

Three findings shaped the index:

1. **`INCLUDE` cannot hold an expression.** `CREATE INDEX … INCLUDE
   (referer_host(referer))` fails outright: `expressions are not supported in
   included columns`.
2. **An index *expression* blocks the index-only scan.** With
   `referer_host(referer)` as a key column, all three report shapes refused
   to go index-only — the best forced plan was a plain Index Scan at 6,703
   buffers, *worse* than the bitmap. With `referer_host` as a **plain stored
   column** in the same position, every shape went `Index Only Scan … Heap
   Fetches: 0`. That is the whole reason §B1 adds a column rather than
   indexing an expression.
3. **The planner does not pick the index-only scan on its own, and I found
   no index shape that makes it.** In every clean-database run it chose a
   Bitmap Heap Scan — stock settings, `effective_cache_size = 4GB`,
   `random_page_cost = 1.1`, with and without `id` in the index, visibility
   map fully set (`relallvisible = relpages`). Only
   `enable_bitmapscan = off` produced the 312-buffer plan. Its own estimates
   show the miss: bitmap costed ~9,540 and ran at 1,678 buffers; the
   index-only scan it rejected costed ~20,170 and ran at 312.

   One run did show the planner choosing the index-only scan freely, from a
   session that had dropped and recreated indexes with repeated
   `VACUUM ANALYZE`. **It did not reproduce in a clean database** and the
   claim is withdrawn.

   So: **the cheap plan exists and is 5.4× cheaper; there is no reliable way
   to make the planner choose it.** §Verification makes this a gate with a
   named fallback. The fallback is not a disaster — the bitmap plan is
   correct, bounded, and still better than no covering index, because the
   index conditions cut what reaches the heap from 24,659 rows to 6,575.

### What that means at 4 million visits

Scaling the measured buffer counts with rows scanned (4M over a year ⇒ ~330k
rows in a 30-day window, 13.4× this test). **Linear extrapolation, not a
measurement** — it ignores index depth and cache behaviour:

| filtered report | index-only | bitmap fallback |
|---|---|---|
| 30-day window | ~33 MB | ~172 MB |
| 90-day window | ~100 MB | ~520 MB |
| **full year** | ~400 MB | ~2 GB |

30 and 90 days are comfortable either way. **The full-year filtered report is
the one that hurts**, which is why §E caps the window at a year.

### An open question this plan does not answer

The unfiltered path reads `visit_days`, and its cost depends on the
dimension, which has not been measured:

- `timeseries` reads `dimension = 'total'`, bounded by `days × links × 2`.
  A month of 500 links is ~30,000 pre-counted rows. Cheap, and it does not
  grow with traffic volume.
- `breakdown` on a **high-cardinality dimension** — `referer`, `destination`,
  `slug` — reads `days × links × distinct values × 2`. On a busy instance
  with many links that could be millions of rollup rows, and it is the
  *default* page load for the Referrers card.

Collapsing referrers to hosts (§B1) cuts that dimension's cardinality by a
large but unmeasured factor. §Verification measures it; if it is bad, the
lever ADR 0007 already names is dropping the high-cardinality dimensions from
the trigger and serving them live — which, after this plan, is a path that
exists.

## B. Schema — `apps/server/src/db/schema.ts`

### B1. `referer_host`, a generated column

```ts
referer: text("referer"),
/** The referer header's host, '' when absent — what the rollup and every
 *  referrer filter key on. A real stored column, not an index expression:
 *  PostgreSQL will not serve an index-only scan out of an index
 *  expression, and this column exists to be in the covering index below.
 *  Generated rather than parsed at ingest so it cannot drift from the
 *  column it derives from, and so Postgres backfills existing rows itself.
 *  See docs/plans/Plan_33.md §A and docs/adr/0015. */
referer_host: text("referer_host").generatedAlwaysAs(sql`referer_host("referer")`),
```

backed by a function, so the extraction rule has exactly one spelling — the
trigger, the rebuild and the column all call it:

```sql
-- '' when there was no referer, and also when it was relative (a same-site
-- referer) — both read as "not recorded", which is what the rollup's ''
-- already means.
CREATE FUNCTION referer_host(u text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(regexp_replace(regexp_replace(coalesce(u, ''),
    '^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^@/]*@)?', ''), '[/?#:].*$', ''))
$$;
```

Verified working as a generated-column expression on PGlite 17.5.
`regexp_replace` is `provolatile = 'i'` in every arity, so the `IMMUTABLE`
label is honest. Spot checks: `https://User:p@WWW.Google.com:443/path` →
`www.google.com`; `android-app://com.foo.bar` → `com.foo.bar`;
`www.bing.com/x` → `www.bing.com`; `null` → `''`.

`www.` is deliberately **not** stripped: it is a different host, and
collapsing it is a product decision nobody has asked for.

**Known costs, accepted deliberately.**

- `CREATE OR REPLACE FUNCTION` does *not* recompute stored values, so
  changing the extraction rule later means replacing the function, then
  `ALTER TABLE visits ALTER COLUMN referer_host DROP EXPRESSION` and
  re-adding it (PG 17 has `SET EXPRESSION`; ADR 0007 pins the floor at 15, so
  15 and 16 take the long road), then re-running §C's rebuild. Get the regex
  right in review.
- Parsing the host in TypeScript at ingest was rejected: the same rule in two
  languages, and the SQL spelling is needed for the rebuild anyway.
- **This decision is coupled to §A finding 3.** The column is a stored column
  rather than a bare function *because* a plain column is what makes the
  index-only scan reachable. If §Verification shows the planner will not go
  index-only on real Postgres, re-open this: a bare `IMMUTABLE` function with
  no column would then do the same job for the trigger and the filter,
  without the table rewrite.

### B2. The covering index

```ts
// Every column a filtered report reads, so the report can answer without
// touching the base table. Measured: 312 buffers and zero heap fetches,
// against 1,678 via a bitmap heap scan (docs/plans/Plan_33.md §A).
// occurred_at leads because the window is the one predicate always
// present. The rest are there for coverage — after a range qual on the
// leading column their order barely matters, so they are narrowest-first.
// `id` is deliberately NOT here. It was, to let the raw log's `order by
// occurred_at desc, id desc` (visits.ts:77) reuse this index, but it costs
// 21% index size and buys nothing measurable: /v1/visits selects columns
// this index does not carry (user_agent, query, destination), so it can
// never go index-only regardless.
// `destination` is absent for the same reason: a full URL with query
// string would roughly double the index to serve one breakdown, which
// falls back to a heap scan.
// ponytail: one covering index. If a filtered report on a busy instance
// still goes slow, the next lever is a partial index on the window people
// actually read, not a btree per filterable column — that would cost the
// redirect path four more writes per visit, which ADR 0007 already warns
// about at eight.
index("visits_analytics_idx").on(
  t.occurred_at.desc(), t.is_bot, t.platform,
  t.link_id, t.domain_id, t.os, t.browser, t.referer_host, t.slug_requested,
),
```

Size: 29 MB per 300k rows measured, so roughly **390 MB at 4M visits** — about
half the base table. One index, not four. Write cost is one more btree insert
per visit, on a path that already writes seven rollup rows and is
fire-and-forget off the response (`src/visits/record.ts:16`).

The three existing `visits` indexes stay. `visits_link_occurred_idx`
(`link_id, occurred_at desc`) prunes far harder than the covering index when
a single link is selected, which is the other common shape.

**Index-only scans need the visibility map**, and an insert-only table only
gets it from autovacuum's insert threshold. Set it explicitly so the newest
days — the ones people read most — are covered:

```sql
ALTER TABLE visits SET (autovacuum_vacuum_insert_scale_factor = 0.02);
```

### B3. `visit_days`

The default landing view is an instance-wide `timeseries` with no
`domain_id` and no `link_id`, and both existing indexes lead with a scope
column (`schema.ts:226-227`), so that query matches neither and scans:

```ts
// The unscoped report — the page everyone lands on — leads with neither
// domain nor link, so neither index above can serve it.
index("visit_days_dimension_day_idx").on(t.dimension, t.day),
```

A fourth write per rollup row, on a table already written seven times per
visit. Bought deliberately: it serves the most-run query in the product.

## C. Migration `0020` — `apps/server/drizzle/`

`bun run db:generate` writes the column and the indexes. The function, the
storage parameter, the trigger and the rebuild are hand-added to the same
file, the way `0017_drop_bot_label.sql` does.

```sql
-- Referrers roll up by host, not by full URL, and filtered reports read
-- the visit log through a covering index. docs/plans/Plan_33.md §A-§C,
-- docs/adr/0015.
CREATE FUNCTION referer_host(u text) ... ;          -- §B1
--> statement-breakpoint
-- A full table rewrite under ACCESS EXCLUSIVE, and migrations run at boot
-- (src/db/migrate.ts) — a large instance's first start after upgrading
-- blocks on it. In exchange Postgres backfills every existing row, so
-- there is no separate backfill UPDATE.
ALTER TABLE "visits" ADD COLUMN "referer_host" text
  GENERATED ALWAYS AS (referer_host("referer")) STORED;
--> statement-breakpoint
ALTER TABLE "visits" SET (autovacuum_vacuum_insert_scale_factor = 0.02);
--> statement-breakpoint
CREATE INDEX "visits_analytics_idx" ON "visits"
  ("occurred_at" DESC, "is_bot", "platform", "link_id",
   "domain_id", "os", "browser", "referer_host", "slug_requested");
--> statement-breakpoint
CREATE INDEX "visit_days_dimension_day_idx" ON "visit_days" ("dimension", "day");
--> statement-breakpoint
-- Whole body re-pasted from 0017_drop_bot_label.sql; only the 'referer'
-- row changes. The visit_counts upsert at the bottom must be copied
-- verbatim too — a partial CREATE OR REPLACE silently stops maintaining
-- the table every link list reads.
CREATE OR REPLACE FUNCTION record_visit_rollup() RETURNS trigger LANGUAGE plpgsql AS $$
  ...
    ('referer'::visit_dimension,     new.referer_host),
  ...
$$;
--> statement-breakpoint
-- Rebuild the one dimension whose values changed meaning; the rest of
-- visit_days is untouched. ADR 0007 calls a rebuild from `visits` the
-- supported repair procedure — this is that, narrowed to one dimension.
--
-- Not safe against an old instance still inserting through the previous
-- function definition: those rows would be counted twice or not at all.
-- linq deploys as a single instance, so this is stated rather than
-- defended against.
DELETE FROM "visit_days" WHERE "dimension" = 'referer';
--> statement-breakpoint
INSERT INTO "visit_days" ("day", "domain_id", "link_id", "dimension", "value", "is_bot", "count")
SELECT (v."occurred_at" AT TIME ZONE 'UTC')::date, v."domain_id", v."link_id",
       'referer'::visit_dimension, v."referer_host", v."is_bot", count(*)
FROM "visits" v
GROUP BY 1, 2, 3, 5, 6;
--> statement-breakpoint
-- Without this the covering index cannot serve an index-only scan on the
-- rows that already exist.
VACUUM ANALYZE "visits";
```

The `GROUP BY` is load-bearing and so is the absence of `ON CONFLICT`: the
`DELETE` cleared the dimension, and the grouped select emits exactly one row
per key — including the `link_id IS NULL` group, which lands on a single row
only because `visit_days_key` is `NULLS NOT DISTINCT` (`schema.ts:223-225`).
Do not "simplify" this into a per-row insert.

drizzle-kit's introspection compares `generation_expression::text`, which
Postgres returns normalised. Expect the first post-migration `db:generate` to
propose a spurious diff on `referer_host`; check and discard it rather than
committing a no-op migration.

## D. `packages/shared/src/primitives.ts` — one CSV helper

`linkListQuerySchema` already hand-rolls comma-separated list params twice
(`packages/shared/src/links.ts:59-68` for `tags`, `:73-83` for `domain_id`),
with a rationale worth keeping: *"Kept as `domain_id` rather than renamed to
plural, so a caller passing a single uuid keeps working unchanged."* Six more
are about to appear, so lift it.

CSV rather than repeated query params, and this is not a style choice:
`hono/dist/validator/validator.js` collapses a single-occurrence query param
to a scalar (`v.length === 1 ? [k, v[0]] : [k, v]`), and
`@hono/zod-validator@0.7.6` does not override that for `query`. A
`z.array(...)` field therefore fails to parse a single-valued param — every
list field would need its own `union + transform`. CSV also matches the
client's `qs()`, which is `Record<string, string>` (`lib/api.ts:100`).

```ts
/** A comma-separated query parameter, as a list. A caller passing one
 *  value keeps working unchanged, which is why these never get plural
 *  names. Absent means an empty list, i.e. no predicate. */
export function csvList<T extends z.ZodType>(item: T) {
  return z
    .string()
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(item))
    .optional()
    .transform((v) => v ?? [])
}
```

Point both existing call sites at it in the same change.

## E. `packages/shared/src/analytics.ts` — new

```ts
/** What a breakdown groups by. `day` is not here: it is its own endpoint,
 *  the only one that comes back chronologically and the only one a chart
 *  plots. */
export const ANALYTICS_DIMENSIONS = ["referer", "os", "browser", "platform", "slug", "destination"] as const

/** What a report can be narrowed by — a subset. Every one of these forces
 *  the read off the rollup (docs/adr/0015), which is why the set is
 *  deliberately smaller than the dimensions. */
export const ANALYTICS_FILTERS = ["referer", "os", "browser", "platform"] as const

/** The rollup stores '' where a dimension was never recorded
 *  (schema.ts:215) — an absent referer, an OS the parser could not name.
 *  '' cannot survive a CSV round trip, so this is its wire spelling. Not a
 *  possible host, OS or browser name, so it cannot collide. */
export const NOT_RECORDED = "(none)"

/** One year. Enforced only where it bites: a window over the rollup is
 *  what the rollup is for; a window over the visit log is the scan §A
 *  prices at ~400 MB per 4M visits. */
export const MAX_RANGE_DAYS = 366
```

The query shape is a plain object so it can be extended before refinement —
`.refine()` yields a schema that cannot `.extend()`:

```ts
const filterValue = z.string().trim().toLowerCase().transform((v) => (v === NOT_RECORDED ? "" : v))

const analyticsQueryShape = {
  /** Absent means all time, which is only allowed on the rollup path. */
  from: z.iso.date().optional(),
  to: z.iso.date().default(() => new Date().toISOString().slice(0, 10)),
  link_id: csvList(uuidSchema),
  domain_id: csvList(uuidSchema),
  orphan: z.enum(["true", "false"]).default("false"),
  bot: z.enum(["true", "false", "any"]).default("any"),
  referer: csvList(filterValue),
  os: csvList(filterValue),
  browser: csvList(filterValue),
  platform: csvList(z.union([platformSchema, z.literal(NOT_RECORDED)])),
}
```

plus two refinements applied by a shared wrapper, so `breakdown` gets them
too:

- `from <= to`;
- **when any `ANALYTICS_FILTERS` list is non-empty**: `from` is required and
  the span must be ≤ `MAX_RANGE_DAYS`. A filtered read scans `visits`; an
  unbounded one is the thing the cap exists for. An unfiltered read is a sum
  over pre-counted rows and needs no bound.

`to` defaults to today rather than being required: `/v1/visits` and
`test/purge.test.ts` both call with no window today, and making a window
mandatory everywhere is a bigger break than this change needs.

`StatsBucket` (`visits.ts:81-86`) is reused unchanged by `timeseries` and
`breakdown`. New: `AnalyticsSummary = { visits, human, bot, orphans }`.

## F. `apps/server/src/http/api/analytics.ts` — new

Two sources behind one API, and the rule for choosing is one predicate:

```ts
/** A filter the day rollup cannot answer. It stores one dimension per row,
 *  so combining two of them — or grouping by one while filtering another —
 *  has to read the visit log. Scope (`link_id`, `domain_id`, `orphan`),
 *  `bot` and the date window are columns of `visit_days` itself and cost
 *  nothing there. ADR 0015. */
function needsDetail(q: AnalyticsQuery): boolean {
  return ANALYTICS_FILTERS.some((f) => q[f].length > 0)
}
```

So: **no dimension filter ⇒ `visit_days`, pre-counted, never touching
`visits`. Any dimension filter ⇒ `visits`, through the §B2 covering index.**
Note these day-windowed reports read `visit_days`, not `visit_counts` — the
latter holds all-time totals with no date dimension and stays what the links
list reads.

**One filter builder, not two.** `visitFilters` (`visits.ts:32-54`) already
builds this `SQL[]` over `visits` for `from/to/bot/link_id/domain_id/orphan/
platform/os/browser`. Generalise it — `eq` → `inArray`, add `referer_host` —
and let `/analytics/*` and `/v1/visits` share it. The raw log gains
multi-value filters for free instead of drifting from analytics; a caller
passing `?os=windows` is unaffected.

Generalising it also fixes a live bug. `visits.ts:43` is
`lte(visits.occurred_at, new Date(q.to))`; with a date-only `to` that cuts at
00:00 and silently drops the last day, while the rollup's
`visit_days.day <= to` includes it. Two paths, two answers to the same
question. The window predicate becomes half-open:

```ts
if (q.from) f.push(gte(visits.occurred_at, new Date(`${q.from}T00:00:00Z`)))
if (q.to)   f.push(sql`${visits.occurred_at} < (${q.to}::date + 1)`)
```

**The two paths must key identically or the same request returns different
bucket names.** The rollup's values come from the trigger, so the detail path
has to reproduce them exactly — and every expression below reads a column
that is in the covering index, which is what keeps the scan index-only:

```ts
const DETAIL_KEY = {
  day: sql<string>`to_char(${visits.occurred_at} at time zone 'UTC', 'YYYY-MM-DD')`,
  platform: sql<string>`${visits.platform}::text`,
  os: sql<string>`coalesce(${visits.os}, '')`,
  browser: sql<string>`coalesce(${visits.browser}, '')`,
  referer: sql<string>`${visits.referer_host}`,
  slug: sql<string>`${visits.slug_requested}`,
  destination: sql<string>`coalesce(${visits.destination}, '')`, // not covered; heap scan
}
```

with `count(*) filter (where not is_bot)` / `filter (where is_bot)` — the
detail analogue of the rollup's `sum(count) filter (…)` at `stats.ts:56-57` —
and the same ordering rule as `stats.ts:68`: chronological for `day`,
`desc(volume), asc(key)` otherwise. Both stay wrapped in `span()`, tagged
with which source served the read, so a slow report is attributable.

`aggregateVisits` and `dayFilters` (`stats.ts:33-71`) are the rollup half and
are **imported, not copied** — `stats.ts` still exists in this plan.
`docs/plans/Plan_34.md` moves them here when it deletes that file.

Routes, mounted `v1.route("/analytics", analyticsRoutes)` alongside the
existing three:

| Route | Returns |
|---|---|
| `GET /api/v1/analytics/summary` | `{ visits, human, bot, orphans }` |
| `GET /api/v1/analytics/timeseries` | `StatsBucket[]`, `YYYY-MM-DD`, chronological |
| `GET /api/v1/analytics/breakdown?dimension=…` | `StatsBucket[]`, ranked by volume |

Filter semantics, on both paths: **OR within a dimension, AND across
dimensions** — `?referer=google.com,x.com&os=windows&platform=desktop` reads
as *(google.com or x.com) and windows and desktop*. The same rule the links
list's `tags` already uses.

`summary` is one query: `human`, `bot` and `orphans` are three `filter (…)`
aggregates over a single scan, and `visits` is `human + bot`. With a
`link_id` filter set, `orphans` is definitionally `0` and is returned without
being queried.

`summary` earns its own endpoint rather than being summed client-side
because `orphans` is not derivable from `timeseries`, and because it costs no
extra round trip: the page that replaces four requests today still makes
four, with the separate orphan timeseries folded into this one.

Buckets with no visits stay **absent rather than zero** — the existing
contract (`stats.ts:46-49`); the client fills the gaps.

## G. Hand-maintained artifacts

Neither is generated; both are edited by hand as part of the change
(`docs/plans/Plan_32.md:370-392`). Verified again: repo-wide, `openapi` appears
only in the spec itself and in plan files — no script, no source, no config.

- `resources/openapi/linq.openapi.json` — **add**
  `/api/v1/analytics/{summary,timeseries,breakdown}`, an `AnalyticsSummary`
  schema and the shared filter parameters. The three `…/stats` paths stay
  until Plan_34. `StatsBucket` and the `StatsBuckets` response are reused.
- `resources/dbml/linq.dbml` — add `referer_host` and both new indexes to
  `Table visits` (`:163-183`); amend the `visit_days` note (`:212`) to say
  the `referer` dimension holds a host. While there, fix `:252`:
  `visits.link_id > links.id [delete: set null]` has been wrong since
  `0010_purge_destroys_visits.sql` made it `cascade`.

## H. `docs/adr/0015-a-filtered-report-reads-the-visit-log.md`

Written with the `linq-adr` skill. ADRs run to 0014; this is 0015.

**Context**: ADR 0007 made every report a sum over a day-grained,
single-dimension rollup, and `stats.ts:44` states outright that "nothing here
scans the visits table". Reports that combine dimensions are not expressible
at that grain.

**Decision**: an unfiltered report still reads `visit_days`; a report
carrying any dimension filter reads `visits`, bounded by a window capped at
one year and served by a covering index carrying every column such a report
reads. The `referer` dimension becomes a host, in a stored generated column.

**Consequences**: two code paths that must agree, guarded by the equivalence
test in §I; the one-year cap is load-bearing, not cosmetic; the covering
index is roughly half the size of the visits table and one more write per
visit; changing the host-extraction rule later requires a column rewrite and
a rollup rebuild; the `''` bucket now needs a wire spelling.

**Rejected**: widening `visit_days` to store dimension *combinations*
(combinatorial — four filterable dimensions, two with open vocabularies, is
not a fixed number of rows per visit); a second rollup keyed on the pairs
actually filtered (same explosion, merely deferred); a btree per filterable
column (four more writes per visit on the redirect path, against ADR 0007's
own warning at eight); a BRIN on `occurred_at` (cannot serve an ORDER BY and
cannot go index-only); an index *expression* for the host instead of a stored
column (measured — it forfeits the index-only scan entirely, §A); computing
the host in TypeScript at ingest (the same rule in two languages, and the SQL
spelling is needed for the rebuild anyway); dropping `slug` and `destination`
from the trigger to cut seven rollup writes to five — ADR 0007 names exactly
that lever, and it is declined because both stay answerable through
`breakdown` at no read cost.

Record the §Verification benchmark's actual `EXPLAIN (ANALYZE, BUFFERS)`
output in the ADR, including whichever plan Postgres chose. If the fallback
in §Verification is taken, the before/after belongs there too, so the next
reader can see what it bought and undo it when the planner improves.

Worth recording as a known asymmetry: `referer` collapses to a host while
`destination` keeps full URLs with query strings, which makes it the
highest-cardinality dimension in the rollup, the one dimension left out of
the covering index, and the first ADR 0007 flags for removal.

## I. Tests

`apps/server/test/analytics.test.ts` — new, alongside the untouched
`stats.test.ts`. Reuse `stats.test.ts`'s seeding (`:14-86`) and its `byKey`
helper (`:90-95`).

- shape and ordering of all three endpoints: chronological for `timeseries`,
  volume-ranked for `breakdown`, `summary.visits === human + bot`.
- **path equivalence — the one test this plan cannot ship without.** For each
  dimension, issue the same logical request twice: once unfiltered (rollup)
  and once with a filter that excludes nothing (detail), and assert identical
  buckets. It is the only thing that catches the two paths keying or
  windowing differently, and it extends the live-aggregate idiom
  `test/visit-rollup.test.ts:29-67` already established.
- the last day of the window is included on both paths — the bug §F fixes.
- multi-filter semantics: two values on one dimension (OR), two dimensions at
  once (AND), three dimensions at once.
- `NOT_RECORDED` round trip: a visit with no referer appears under `''` and
  is reachable with `?referer=(none)`.
- `referer_host`: `https://www.google.com/search?q=x` buckets under
  `www.google.com`; a relative referer under `''`.
- 400s: `to` before `from`; a dimension filter with no `from`; a dimension
  filter spanning over 366 days; an unknown `dimension`.
- a `viewer` key reads all three, matching `stats.test.ts:175-178`.

`apps/server/test/visit-rollup.test.ts:16` needs one edit: `DIMENSIONS.referer`
becomes `visits.referer_host`. Its live-aggregate comparison is the only
thing proving the §C rebuild was right, and it will fail until that line
moves — that failure is the test working.

**Do not assert query plans in tests.** PGlite ships with `enable_seqscan`
off, so any plan shape or timing measured there is flattering and not
transferable. Index behaviour is checked by hand (§Verification).

## Files

- `apps/server/src/db/schema.ts` — `referer_host`, two indexes
- `apps/server/drizzle/0020_*.sql` (+ `meta/`) — generated, then hand-extended
- `apps/server/src/http/api/analytics.ts` — new
- `apps/server/src/http/api/visits.ts` — `visitFilters` generalised, window fixed
- `apps/server/src/http/app.ts` — one new mount
- `apps/server/test/analytics.test.ts` — new
- `apps/server/test/visit-rollup.test.ts` — one line
- `packages/shared/src/analytics.ts` — new
- `packages/shared/src/primitives.ts` — `csvList`
- `packages/shared/src/links.ts` — two CSV params onto `csvList`
- `packages/shared/src/index.ts` — exports
- `docs/adr/0015-…md`, `resources/openapi/linq.openapi.json`,
  `resources/dbml/linq.dbml`

Nothing in `apps/client` is touched by this plan.

## Sequencing

1. §B + §C — column, function, indexes, trigger, rebuild. Verify with
   `bun test apps/server/test/visit-rollup.test.ts` after moving its
   `DIMENSIONS.referer` line.
2. **The §Verification benchmark, before any endpoint is written.** Every
   unknown in this plan lives here, and it is cheapest to learn while the
   index is the only thing built.
3. §D + §E — shared schemas.
4. §F — the endpoints, both paths, with §I's equivalence test written
   alongside rather than after.
5. §G + §H — OpenAPI, DBML, ADR.

## Verification

- `bun run test`, `bun run typecheck`, `bun run lint`. The Client UI is
  untouched and must still work against the old endpoints throughout.
- **The benchmark gate, on real Postgres — not PGlite.** Seed 4,000,000
  visits over 365 days across a few hundred links with a realistic spread of
  referrer hosts, `VACUUM ANALYZE`, then `EXPLAIN (ANALYZE, BUFFERS)`:
  1. a filtered `timeseries` over 30 days,
  2. a filtered `breakdown` over 30 days,
  3. both over a full year,
  4. **an *unfiltered* `breakdown?dimension=referer` over 30 days** — the
     open question in §A, and the default page load. Record how many
     `visit_days` rows it touches.

  Pass condition for 1–3: `Index Only Scan using visits_analytics_idx` with
  `Heap Fetches` near zero.

  Expect that not to happen. The planner chose a Bitmap Heap Scan in every
  clean PGlite run (§A) and no index shape changed it. If real Postgres does
  the same, the named fallback is a **per-statement**
  `SET LOCAL enable_bitmapscan = off` around the detail-path query only —
  never global, never on the rollup path, never on a write, and only with the
  before/after `EXPLAIN` pasted into the ADR. Bitmap scans are the right plan
  for plenty of other queries in this app.

  If neither works, the honest position is that the covering index buys the
  smaller win it demonstrably buys — 6,575 rows reaching the heap instead of
  24,659 — and the one-year cap does the rest. **Settle this before building
  the endpoints**, because it decides whether §A's headline number is real
  and whether §B1's column is still the right call.
- Hit all three endpoints by hand with a key: no filters, one filter, three
  filters, a filter naming `(none)`, a 367-day window with a filter (expect
  400), a 367-day window without one (expect 200).

## Risks

- **The index-only scan is not guaranteed — the biggest open question.** The
  index makes the plan *possible* and measurably 5.4× cheaper, and the
  planner preferred a bitmap heap scan anyway in every clean run, costing the
  cheaper plan at roughly twice the dearer one. Treat §A's 33 MB figure as a
  ceiling, not a default.
- **§B1 is coupled to that gate.** If the index-only scan is unreachable, the
  generated column's main justification goes with it and a bare function
  becomes the better trade. Re-decide rather than inherit.
- **The unfiltered high-cardinality breakdown is unmeasured** (§A). It is the
  default page load, and it is item 4 of the benchmark for that reason.
- **The table rewrite.** `ADD COLUMN … GENERATED … STORED` rewrites `visits`
  under `ACCESS EXCLUSIVE`, at boot. A 4M-row instance's first start after
  upgrading will be slow.
- **Changing the host regex later is expensive** — a column rewrite plus a
  rollup rebuild, with no `SET EXPRESSION` shortcut on PG 15/16.
- **Two paths, one contract.** §I's equivalence test is the only thing making
  that true, and the last-day window bug §F fixes is the class of thing it
  catches.
- **The rebuild is a one-shot**, assuming no other instance is writing visits
  through the old trigger. Single-instance deploy makes it safe; the
  migration says so rather than leaving it implied.
- **Index size**: ~390 MB at 4M visits, about half the base table, plus one
  more btree write per visit.
- **Two report APIs coexist** until Plan_34 lands. Deliberate, and the reason
  the client keeps working; it is also a reason not to leave Plan_34 sitting.
