# linq — Plan 14: geolocation comes out, and the slug stays put

Follows `plans/Plan_13.md`.

## Context

Two asks, and they turn out to be very different sizes.

**Geolocation goes.** linq currently resolves a coarse country for every visit
by downloading an 8 MB MMDB file from a third party at boot and reading it with
`maxmind`. That decision was made twice over — `docs/adr/0004` chose the vendor
so the feature would work with no account or licence key, and `docs/adr/0005`
gave the file its own volume and its own three settings. The requirement now is
the opposite one: no external API calls, no MMDB files. Nothing replaces it.
There is no header-based fallback, because an origin reachable directly
receives attacker-controlled headers, and linq does not control how operators
deploy it — that was already settled in ADR 0004 and it is still true.

Removing the lookup is not enough on its own, because two features are built on
top of it and both fail silently once it is gone:

- The `country` Rule condition (`packages/shared/src/rules.ts:16-23`) compares
  against `MatchContext.country`, which becomes permanently `null`. A rule
  carrying one can be saved through the API and the UI, and can then never
  match. `apps/server/test/rules.test.ts:338-378` already pins that exact
  behaviour ("a country rule needs geo").
- `country` and `region` are rollup dimensions (`apps/server/src/db/schema.ts:146-154`)
  and `groupBy` values (`packages/shared/src/visits.ts:4-14`). They would keep
  answering, with one bar labelled `''` holding every visit ever recorded.

So the removal reaches the Rule condition set and the visit schema, not only the
lookup. `region`, worth noting, has been dead since the DB-IP swap —
`apps/server/src/visits/geo.ts:81` hard-codes it to `null` — so dropping it
removes a column nothing has written to in the current code.

**The slug is already immutable.** The second ask is, on inspection, done.
`linkPatchSchema` (`packages/shared/src/links.ts:20-28`) is a `strictObject`
with no `slug` key, so `PATCH /api/v1/links/:id` answers `400` for a body
carrying one; `apps/server/test/links.test.ts:111-127` asserts it; the edit form
renders the slug `disabled readOnly` (`apps/client/app/links/detail/page.tsx:248-250`);
and `CONTEXT.md` has called the Slug "Immutable" all along. The one real gap is
a type gap, not a behaviour one, and it is §7 — a single line.

## Decisions

- **`maxmind` is dropped and nothing replaces it.** No header fallback, no
  optional provider interface, no `LINQ_GEO_*` switch left behind for a future
  re-introduction. A switch for a subsystem that does not exist is a setting
  that can only confuse.
- **The `country` Rule condition is removed from the union**, not kept and
  rejected on write. `conditionSchema` becomes `platform | query_param`. A
  condition type that is accepted and never fires is worse than one that is not
  offered; a `400` on write would be honest but would leave a branch, a UI
  option and a set of tests alive to serve a feature that is gone.
- **`visits.country` and `visits.region` are dropped**, along with their two
  `visit_dimension` enum values. Nothing has shipped, so there is no data to
  preserve and no compatibility window to keep. A nullable column nobody writes
  is a column nobody can explain.
- **The removal is a forward migration, `0006`, not an edit of `0000`–`0005`.**
  That is the pattern every prior schema change in this repo followed, including
  the renames in `0002` and `0003`, and it keeps working for anyone holding a
  development database.
- **`clientIp()` goes with it.** `apps/server/src/http/redirect.ts:123` has
  exactly one caller — the geo lookup at line 169. With geo gone, linq stops
  reading the client address at all, which turns ADR 0001 and ADR 0003 from
  promises about what is *stored* into a statement about what is *read*.
- **ADRs 0004 and 0005 are superseded, not deleted**, by a new `0010`. They are
  a record of a decision that was made and then reversed, and the reversal is
  the interesting part.

---

## 1. The geolocation subsystem comes out

Delete outright:

- `apps/server/src/visits/geo.ts` — the whole module: `startGeo`, `noGeo`,
  `Geo`, `Location`, the daily timer, `isStale`, `monthStamp`, `downloadMmdb`.
- `apps/server/test/geo.test.ts` — the whole file (146 lines), all of which
  tests download, supplied-path and staleness behaviour that no longer exists.
- `data/dbip-country-lite.mmdb` — the downloaded copy on disk. Gitignored via
  `.gitignore:4`, so this is a local cleanup, not a tracked deletion.

Unwire the dependency injection — `geo` is threaded through the Hono context
the same way `db` and `cache` are, so it comes out at each seam:

| File | Lines | What goes |
|---|---|---|
| `apps/server/src/http/env.ts` | 5, 16 | the `Geo` import and the `geo: Geo` context variable |
| `apps/server/src/http/app.ts` | 11, 23, 29, 38 | the `geo` option, its `noGeo` default, and the `c.set("geo", …)` |
| `apps/server/src/main.ts` | 9, 21, 23, 41 | `startGeo(config)` at boot and `geo.stop()` on shutdown |
| `apps/server/test/helpers/app.ts` | 7, 44, 53 | the `Geo`/`noGeo` harness injection |

In `apps/server/src/http/redirect.ts`, remove `clientIp()` (123-129) and the
`...c.var.geo.lookup(clientIp(c))` spread at 169. Check whether the `Context`
type import is still used after `clientIp` goes.

Config (`apps/server/src/config.ts:32-41` and the `LINQ_GEO_DIR` default at
63-70): drop `LINQ_GEO_ENABLED`, `LINQ_GEO_DB_PATH` and `LINQ_GEO_DIR`. Note
that `LINQ_DATA_DIR` keeps its other consumer, the rotating log file, so it
stays. `apps/server/test/helpers/db.ts:30-32` sets all three in `testConfig` and
loses them too.

Finally, `maxmind` comes out of `apps/server/package.json:18`, followed by
`bun install` to update `bun.lock`.

## 2. The `country` Rule condition

`packages/shared/src/rules.ts:16-23` — delete the third member of
`conditionSchema`. `Condition` and `ConditionType` narrow to `platform` and
`query_param` on their own; nothing else in that file changes.

`apps/server/src/rules/match.ts` — drop `country` from `MatchContext` (7-8) and
the `case "country"` arm (21-22). `apps/server/src/http/redirect.ts:182-186`
stops passing `country` into `matchRules`.

`apps/client/components/rules-editor.tsx` — remove the `{ value: "country",
label: "Country is" }` option (18-22), the `blankCondition("country")` default
of `{ type: "country", value: "IN" }` (33), and the two-character country input
at 260-268. The default for a new condition needs to be a type that still
exists; `platform` is the natural one.

One thing to look at while editing 33: if `blankCondition` currently switches on
a type that can no longer occur, the switch may collapse to fewer arms than
biome will accept as a switch. A small shape change there is expected.

## 3. `visits` loses `country` and `region` — migration `0006`

This is the only part with a real ordering hazard, because **PostgreSQL cannot
drop a value from an enum type**. The type has to be rebuilt, and the rows
carrying the doomed values have to go first.

Generate the migration with `bun run db:generate --name drop_geolocation` so the
journal entry and meta snapshot are real, then replace the generated SQL body —
it recasts rows that still hold the doomed values and never touches the trigger.
Keep drizzle's cast-through-`text` shape and add what it cannot know about:

1. `DELETE FROM "visit_days" WHERE "dimension" IN ('country', 'region');`
2. `ALTER TABLE "visit_days" ALTER COLUMN "dimension" SET DATA TYPE text;`
3. `DROP TYPE "visit_dimension";` then recreate it with the five surviving values.
4. `ALTER TABLE "visit_days" ALTER COLUMN "dimension" SET DATA TYPE "visit_dimension" USING …`
5. `CREATE OR REPLACE FUNCTION record_visit_rollup()` — the body of
   `apps/server/drizzle/0005_visit_rollup_triggers.sql:4-30` minus the two
   `VALUES` rows at 14-15. **This must land before step 6**, or the first visit
   after the column drop hits a function still reading `new.country`.
6. `ALTER TABLE "visits" DROP COLUMN "country";` and the same for `"region"`.
7. **Delete rules that used a `country` condition**, whole:
   `DELETE FROM "rules" WHERE "conditions" @> '[{"type": "country"}]';`
   Not stripped — conditions are ANDed, so removing one broadens the rule.
   "country is IN and platform is android" would start matching every Android
   visitor anywhere, silently rerouting exactly the traffic the rule excluded.
   Deleting falls back to the link's default destination, the safe failure.
8. **Renumber what survives**, so each link's `position` stays gapless. Shift
   every row clear of the live range first (`position + 1000000`), then
   `row_number() OVER (PARTITION BY link_id ORDER BY position) - 1`:
   `rules_link_position_key` is checked row by row, so renumbering in place can
   collide with a row that has not been updated yet.

Step 4 rebuilds the unique index on `(day, domain_id, link_id, dimension,
value, is_bot)` automatically; there is nothing to recreate by hand. The
backfill `SELECT` at `0005_visit_rollup_triggers.sql:89-90` is a one-shot that
already ran and is not re-executed, so it is left alone — it lives inside a
migration that is a historical record.

Then the Drizzle side:

- `apps/server/src/db/schema.ts:127-129` — remove the `country` and `region`
  columns and the ADR-0001 comment above them. Check whether the `char` import
  is still used by anything else in the file.
- `apps/server/src/db/schema.ts:146-154` — remove `"country"` and `"region"`
  from `visitDimensionEnum`.
- Run `bun run db:generate` to produce the `0006` journal entry and meta
  snapshot, then replace the generated SQL body with the hand-written statements
  above. That is how `0004` and `0005` came to look the way they do.

## 4. The API surface

- `packages/shared/src/visits.ts:4-14` — `"country"` and `"region"` come out of
  `GROUP_BY`, which narrows `statsQuerySchema`'s enum (line 44) for free.
- `packages/shared/src/visits.ts:62-63` — the two fields come off the `Visit`
  type.
- `apps/server/src/http/api/visits.ts:20-21` — `toVisit()` stops mapping them.
- `apps/server/src/http/api/stats.ts` — no logic change. `dimensionOf` (28-30)
  and `aggregateVisits` (51-71) are generic over the dimension, so they follow
  the enum. Only the doc comment at 20-27, which uses "region" as its worked
  example of the `''` sentinel, needs a different example — `referer` is right
  there in the same sentence.

`resources/openapi/linq.openapi.json`:

| Lines | What goes |
|---|---|
| 1562-1579 | `country`, `region` out of the `GroupBy` query-param enum |
| 2049-2066 | the whole `country` branch of the `Condition` `oneOf` |
| 2134-2135 | `country`, `region` out of `Visit.required` |
| 2183-2196 | the `Visit.country` and `Visit.region` property definitions |

`resources/dbml/linq.dbml`: the `visit_dimension` enum entries (48-49), the two
`visits` columns (151-152), and the `country` mention in the rules `conditions`
note (130).

## 5. The client

- `apps/client/components/stats-panel.tsx:20-28` — drop the `country` and
  `region` entries from `GROUP_LABELS`; the picker at 68/78/117 reads `GROUP_BY`
  and follows on its own.
- `apps/client/components/visits-card.tsx` — remove the `"Location"` column
  header (70) and the `[visit.region, visit.country]` cell (130-132).
- `apps/client/app/orphans/page.tsx:64` — this page passes its groups
  explicitly; drop `"country"` and `"region"` from the array.
- `apps/client/components/common.tsx:329-347` — **delete `GeoAttribution`**, and
  its two render sites (`stats-panel.tsx:15,211` and `visits-card.tsx:8,146`).
  The CC BY 4.0 attribution is a condition of using the database; with no
  database there is nothing to attribute, and a dangling credit link to a vendor
  linq no longer calls is worse than no credit at all.

## 6. Packaging, configuration and documentation

- `Dockerfile:25-29,47` — remove `ENV LINQ_GEO_DIR=/geo`, its two comment lines,
  and `VOLUME /geo`. `/data` keeps its volume for `logs/`.
- `docker-compose.example.yml:44-47,53-60,62-65` — remove the commented
  `LINQ_GEO_ENABLED` / `LINQ_GEO_DB_PATH` env, the `linq-geo:/geo` mount and its
  commented bind-mount alternative, and the `linq-geo` named volume. The comment
  block at 55-56 explaining why `/data` and `/geo` are separate goes with them.
- `.env.example:40-51` — the three `LINQ_GEO_*` entries.
- `README.md:100-102` — the paragraph describing the boot-time download.
- **`NOTICE` is deleted.** Its entire content is the DB-IP attribution; its
  opening sentence is "linq bundles no third-party data, but downloads one
  database at runtime", which stops being true and has nothing to replace it.
- `CONTEXT.md` — the **Condition** entry drops its `country` clause, and the
  **Visit** entry drops `country` and `region` from the list of what a Visit
  carries. The **Slug** entry already says "Immutable" and is left exactly as
  it is; §7 is about making the code match it, not the glossary.
- `docs/adr/0001-clicks-never-store-client-ip.md:7,11` and
  `docs/adr/0007-visit-counts-are-rolled-up-by-trigger.md:17` mention country in
  passing and need a light edit, not a rewrite.
- **New `docs/adr/0010-no-geolocation.md`**, marking 0004 and 0005 as
  **Superseded** by it (adding a superseded banner to each). It should record:
  that the constraint is no external calls and no data files rather than a
  problem with the vendor; that the `country` Rule condition went with the
  lookup because a condition that can never match is a trap; that `region` was
  already dead; and that linq now never reads the client address, which is a
  stronger position than ADR 0001's "never stores it".

## 7. Slug immutability — what is actually missing

The behaviour is already enforced, in three independent places:

- `packages/shared/src/links.ts:20-28` — `linkPatchSchema` is a `strictObject`
  whose keys are `destination`, `name`, `tags`, `forwardQuery`, `status`,
  `ownerId`. No `slug`, no `domainId`, and strict means a `400` naming the
  offending key rather than a silent drop. The `.set({ ...patch })` spread at
  `apps/server/src/http/api/links.ts:236` is safe precisely because the
  validator is strict.
- `apps/server/test/links.test.ts:111-127` — "slug and domainId are immutable
  and rejected outright" asserts the `400` for both and re-reads the link to
  confirm nothing moved.
- `apps/client/app/links/detail/page.tsx:248-250` — the slug renders `disabled
  readOnly`, and the save payload at 127-136 is `{ destination, name, tags,
  forwardQuery, ownerId? }`.

No other code writes `links.slug`: `grep` for `update(links)` across
`apps/server/src` finds only the patch, archive and purge handlers in
`links.ts`. Which is the answer to the second ask — **there is nothing to
build.**

The one gap is a type gap. `apps/client/lib/store/links.ts:38` and `:43` type
both mutation bodies as `Record<string, unknown>`, so the client has no
compile-time guard: a future edit that adds a slug field to the settings form
would typecheck cleanly and fail at runtime with a `400`. `@linq/shared` is
already imported on line 1, so the fix is two words:

```ts
createLink: build.mutation<Link, LinkCreate>(…)
updateLink: build.mutation<Link, { id: string; body: LinkPatch }>(…)
```

Since the slug is read-only in edit mode, consider adding a one-line hint under
the disabled input ("Slugs can't be changed — archive and recreate the link") so
the disabled state reads as a rule rather than as a bug. That is the only
user-visible change in this section.

## 8. Tests

Deleted: `apps/server/test/geo.test.ts` (whole file).

Edited:

- `apps/server/test/redirect.test.ts:141-142` — drop `country: null, region: null`
  from the expected visit; **287-325** — delete the whole `describe("geo")`
  block, including the fake geo returning `{country:"IN",region:"Gujarat"}` and
  the XFF assertion. The assertion that no `ip` column exists is worth keeping
  if it can be rehomed; it is the one thing in that block that still has a
  subject.
- `apps/server/test/rules.test.ts` — the ctx builder (13-16), the
  case-insensitivity and null-geo cases (68-79), the country fixtures and
  uppercase-normalisation assertions (87, 104, 150, 156, 173, 177), and the
  end-to-end "a country rule needs geo" (338-378) all go.
- `apps/server/test/stats.test.ts` — the `country`/`region` values in the seeded
  fixtures (34-35, 47-48, 59-60, 236) and the two `groupBy` assertions (107-114).
- `apps/server/test/visit-rollup.test.ts:16-17` — the `country`/`region`
  entries in the `DIMENSIONS` map, which every rollup assertion iterates.
- `apps/server/test/helpers/db.ts:30-32` and `apps/server/test/helpers/app.ts`
  as described in §1.

Nothing new is needed for §7 — `links.test.ts:111-127` is already the test, and
it must stay green untouched, which is the proof that this plan does not
weaken slug immutability while moving other things around.

## Sequencing

1. **§3 first**, schema and migration, because the type errors it produces are
   the checklist for everything else. `bun run typecheck` after it points at
   every remaining reader of `country`/`region`.
2. **§1 and §2**, the server-side removal and the Rule condition.
3. **§4**, the shared types and the two generated-artifact files.
4. **§5**, the client.
5. **§8**, the tests — last, so the suite is compiled against the finished shape
   rather than chased through five intermediate ones.
6. **§7**, the two-word type tightening and the form hint. Independent of
   everything above; could be done first or last.
7. **§6**, packaging and docs, including the new ADR.

Steps 1–5 do not typecheck individually; the tree is only green at the end of 5.

## Verification

1. `bun install` (after `maxmind` comes out), then `bun run typecheck`,
   `bunx biome check .`, `bun test`.
2. Against a development database that has already run `0000`–`0005` **and holds
   visits**: run the migration and confirm it applies cleanly, that
   `select distinct dimension from visit_days` returns five values, and that
   `\d visits` shows no `country` or `region`. Applying `0006` to a fresh,
   empty database is *not* a sufficient test — step 1 of the migration is a no-op
   there, and step 3's `USING` cast is exactly what an unseeded run cannot exercise.
3. Record a visit after migrating and confirm the trigger still fires: a new
   `visit_days` row for `total`, `platform`, `referer`, `destination` and `slug`,
   and no error from `record_visit_rollup()`.
4. `grep -rin "geo\|maxmind\|mmdb\|country\|region" apps packages resources docs
   README.md NOTICE .env.example Dockerfile docker-compose.example.yml` returns
   nothing outside `plans/` and the superseded ADRs. `plans/` is a frozen record
   and is never edited.
5. Start the server and confirm the boot log has no `geo:` line, that no request
   goes to `download.db-ip.com` (watch it with the network off — the server must
   boot normally), and that `data/` contains only `logs/`.
6. Rule cleanup, on a database seeded with rules: a `country`-only rule and a
   mixed `country AND platform` rule are both gone afterwards, sibling rules keep
   their relative order with a gapless `position`, and
   `select count(*) from rules where conditions @> '[{"type":"country"}]'`
   returns 0. The mixed rule is the one that matters — stripping rather than
   deleting would leave it matching every Android visitor.
7. In the UI: the stats grouping picker offers day, platform, referer,
   destination and slug; the visits table has no Location column; the rules
   editor offers only Platform and Query parameter; no DB-IP credit appears
   anywhere.
8. Slug, unchanged behaviour, worth re-confirming by hand since it is half the
   ask: `PATCH /api/v1/links/{id}` with `{"slug":"nope"}` returns `400` naming
   `slug`, and the edit form shows the slug greyed out with the new hint.

## Risks

- **The enum rebuild is the one irreversible step.** `DROP TYPE` after the
  column has been recast cannot be undone by re-running anything, and any
  `visit_days` row holding `country` or `region` is deleted outright in step 1.
  That is intended — the data describes a feature that no longer exists — but it
  is real deletion in a migration, and an operator with a development database
  they care about should dump it first. There is no down-migration in this repo
  and this plan does not add one.
- **Historical country data is destroyed, not archived.** Anyone who wanted the
  counts kept for a later re-introduction does not get them. Re-adding
  geolocation later is therefore a fresh start, not a resumption.
- **`region` was already null-only, `country` was not.** The two columns are
  being removed in one step but they are not equivalent losses: dropping
  `region` removes nothing that current code ever wrote, dropping `country`
  removes a dimension that was genuinely populated. Worth being honest about in
  ADR 0010 rather than presenting the removal as uniformly cheap.
- **Rules that used `country` are deleted, not repaired.** Migration `0006`
  removes them whole and renumbers what is left. Stripping the condition instead
  would broaden the rule and silently reroute traffic, so deletion is the safe
  failure — but anyone who had such a rule loses that routing, their link serves
  its default destination, and nothing tells the owner it happened.
- **A warm Redis cache can outlive the migration.** A deleted `country` rule may
  sit in a cached target entry until it expires. It cannot misroute: an unknown
  condition type matches nothing, so the rule is skipped as if absent.
- **`clientIp()` disappearing removes the only place linq parsed
  `X-Forwarded-For`.** Nothing else uses it today. If rate limiting or
  per-address abuse controls are ever wanted, that parsing — and its
  trusted-proxy question, which was never really settled — comes back from
  scratch.
- **Deleting `NOTICE` is right today and easy to forget tomorrow.** The next
  third-party data source that gets bundled or fetched will need it recreated,
  and there will be no file sitting there to remind anyone.
