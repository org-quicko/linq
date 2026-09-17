# linq — Plan 19: link purge destroys visit data instead of orphaning it

Follows `plans/Plan_18.md`.

## Context

Today, purging a link reclassifies its traffic as orphan traffic rather than
destroying it: `visits.link_id` falls back to `NULL` (`ON DELETE SET NULL`),
and a trigger on `links` merges that link's `visit_counts`/`visit_days` rows
into the domain's existing orphan totals. A purged link's numbers survive,
just detached — they show up in the Orphan Visits page.

That was a deliberate choice (`docs/adr/0007`), but on reflection it's the
wrong one: it makes "purge" — described everywhere else as destruction — the
one purge path that actually preserves data, and it inflates a domain's
orphan-traffic numbers with history that belongs to a link someone chose to
delete for good. This plan changes link purge to destroy its visit data
outright, the same way domain purge already does, so "purge" means the same
thing everywhere.

Genuine orphan visits (a request that resolved to no active link at request
time — unknown slug, archived link, root path with no fallback) are
unaffected. This only removes the purge-time reclassification mechanism.

Domain purge is unchanged — it already hard-destroys everything for that
domain via plain `ON DELETE CASCADE`, no trigger involved.

## 1. `apps/server/src/db/schema.ts:109`

Change `visits.linkId`'s FK action:

```ts
linkId: uuid("link_id").references(() => links.id, { onDelete: "cascade" }),
```

(was `{ onDelete: "set null" }`). The column's doc comment ("`link_id` null
means an orphan visit") stays accurate — genuine orphans still insert with
`link_id = NULL`.

## 2. New migration `apps/server/drizzle/0010_purge_destroys_visits.sql`

Run `bun run db:generate` after step 1 to scaffold the FK change, then rename
the generated file to `0010_purge_destroys_visits.sql` (update the matching
`tag` in `apps/server/drizzle/meta/_journal.json` and the snapshot filename),
and hand-append the trigger function change — the same two-part shape
`0006_drop_geolocation.sql` used when it hand-added a `CREATE OR REPLACE
FUNCTION` alongside drizzle-generated column drops, since triggers/functions
have no drizzle-kit model.

Expected content, following the why-first header convention of `0005` and
`0009`:

```sql
-- Link purge now destroys that link's visit data instead of reclassifying it
-- as orphan traffic. Purging used to fall `visits.link_id` back to NULL and
-- merge the link's rollup rows into the domain's orphan totals — both made an
-- active link's own traffic look like orphan traffic. See docs/adr/0007: the
-- rollups are always supposed to equal a live aggregate over `visits`, so raw
-- visits and rollups have to be destroyed together. Genuine orphan visits — a
-- request that resolved to no active link at insert time — are untouched:
-- they still insert with `link_id` NULL and still roll up as orphan traffic.
--
-- No backfill: this only changes what happens to rows deleted by a *future*
-- purge, so nothing already stored needs migrating.
--
-- Order matters only in that Postgres has no `ALTER ... ON DELETE`: the FK's
-- action is swapped by dropping and re-adding the constraint.
ALTER TABLE "visits" DROP CONSTRAINT "visits_link_id_links_id_fk";--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_link_id_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Deletes the purged link's rollup rows instead of merging them into the
-- domain's orphan scope. Function name kept as `orphan_visit_rollups` — the
-- same low-diff move 0006_drop_geolocation.sql made for `record_visit_rollup`
-- when its dimensions changed underneath it. The trigger name,
-- `links_purge_rollup`, stays accurate either way.
CREATE OR REPLACE FUNCTION orphan_visit_rollups() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "visit_days" WHERE "link_id" = old.id;
  DELETE FROM "visit_counts" WHERE "link_id" = old.id;

  RETURN NULL;
END $$;
```

Keep the function name `orphan_visit_rollups` — renaming would need a
`DROP TRIGGER`/`CREATE TRIGGER` pair (no `ALTER TRIGGER ... EXECUTE FUNCTION`
in Postgres) for a name nothing calls directly.

## 3. `docs/adr/0007-visit-counts-are-rolled-up-by-trigger.md`

Replace the Decision paragraph (lines 39–42):

> Purging a link turns its visits into orphans, so a second trigger on the
> links table merges that link's rollup rows into the orphan scope, set-based,
> rather than leaving them pointing at an id that no longer exists. Purging a
> domain takes its rollups with it by cascade, as it already takes its visits.

with:

> Purging a link destroys its rollup rows outright, in the same trigger that
> runs on `links`' `AFTER DELETE`. It has to: `visits.link_id` is
> `ON DELETE CASCADE`, so purge already destroys the link's own visits, and the
> rollups must always equal a live aggregate over `visits` — leaving rollup
> rows behind, orphaned or not, would break that equivalence the moment the
> visits they summarize are gone. Purging a domain takes its rollups with it by
> cascade, as it already takes its visits.

No other part of the ADR needs touching.

## 4. `CONTEXT.md` — Purge definition (line 22)

Replace:

> **Purge**: the irreversible destruction of an archived Link or Domain, by an
> admin. Distinct from archiving, which is what `DELETE` does. Purging a Link
> releases its Slug and leaves its Visits as Orphan Visits; purging a Domain
> destroys its Visits with it.

with:

> **Purge**: the irreversible destruction of an archived Link or Domain, by an
> admin. Distinct from archiving, which is what `DELETE` does. Purging a Link
> releases its Slug and destroys its Visits with it; purging a Domain destroys
> its Visits the same way.

**Orphan Visit** (line 13) is untouched — it describes insert-time resolution
failure, unrelated to purge.

## 5. `apps/server/src/http/api/links.ts:258-264`

The purge route's doc comment says "visits stay as orphans, which is what the
`set null` on `visits.link_id` is for" — false after step 1. Update in the
same change (it's the exact code path being touched) to something like:

> Rules and visits go with it — `visits.link_id` is `ON DELETE CASCADE`, so a
> link's own traffic is destroyed, not reclassified as orphan traffic.

## 6. `apps/server/test/purge.test.ts` (lines 80–95)

Rewrite `"its visits survive as orphans"` — currently asserts the total is
unchanged (4) and the orphan-filtered count rises to 4 after purge — to assert
destruction instead, mirroring the domain-purge test's shape (lines 147–162):

- After archive + purge, `totalVisits(fresh, "", boss.key)` is `0` (was
  asserted unchanged at `4`).
- `totalVisits(fresh, "orphan=true", boss.key)` stays `0` (was asserted to
  rise to `4`).
- Replace the inline comment (line 92) — "Nothing lost, only detached" is now
  false.
- Rename the test, e.g. `"its visits are destroyed with it"`.

## 7. `apps/server/test/visit-rollup.test.ts` — `describe("purge", ...)` (lines 178–221)

**Test 1** (lines 179–198): the JSDoc above it ("Purging a link detaches its
visits; the rollups must detach with them") and the test name ("a purged
link's rollups become orphan rollups") both describe the old behavior — update
both. Keep `traffic()`'s existing setup (it already produces two genuine
orphan visits on the same domain as link `one`). Before purging `one`, capture
the domain's existing orphan-scoped `visitCounts`/`visitDays` baseline. After
archiving + purging `one`:
- Keep the existing assertion that `visitDays` rows with `linkId = one.id` are
  now `0` (line 196–197) — still true, now because they're deleted rather than
  moved.
- Add an assertion that the domain's orphan-scoped rollup rows are **unchanged**
  from the pre-purge baseline — proving the link's traffic was not merged in.
- The live-aggregate-vs-rollup comparison (lines 191–194) still holds, since
  visits and rollups for `one` are now destroyed symmetrically.

**Test 2** (lines 200–221, `"a purged domain takes its rollups with it"`):
currently manufactures its only orphan rollup row by purging link `doomed`
first — which no longer produces one under the new behavior, making the
domain-cascade assertion vacuous. Add genuine orphan traffic independently
(e.g. `h.recordVisits(null, spare, { human: 1 })`, the same direct-insert
technique `purge.test.ts` already uses) before purging `doomed`, so there's
still an orphan-scoped row on `spare` to prove the domain purge (not the link
purge) is what removes it.

## 8. Already checked, no change needed

`apps/server/test/stats.test.ts` and `apps/server/test/visits.test.ts` build
their orphan fixtures via direct `h.recordVisits(null, domain, ...)` inserts,
never via a link purge — neither depends on purge-time reclassification.

## Sequencing

1. Schema change (§1) + migration (§2) — generate, rename, hand-edit.
2. Docs (§3 ADR, §4 CONTEXT.md, §5 route comment).
3. Test rewrites (§6, §7).

## Verification

```
bun test apps/server/test/purge.test.ts apps/server/test/visit-rollup.test.ts
bun run test
bun run typecheck
```

Manual sanity check (no code change needed): `apps/client/app/orphans/page.tsx`
only consumes the existing `orphan=true` filter, so its numbers should simply
come out smaller/more accurate after a link purge — no client change required.

## Risks

- This is a real behavior and data-destruction change: a link purge now
  destroys visit history that survives today. Nothing to migrate for existing
  data (only future purges are affected), but it's worth confirming this is
  acceptable for any operator relying on today's "purge keeps the numbers"
  behavior.
- Dropping and re-adding the FK constraint briefly locks `visits` (per the
  usual cost of an `ALTER TABLE ... ADD CONSTRAINT` on a large table);
  no different in kind from other migrations already in this repo.
