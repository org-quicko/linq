# linq — Plan 24: swap OS/browser detection to ua-parser-js; surface bot type

Follows `docs/plans/Plan_23.md`.

## Context

Two changes, decided over discussion:

1. **Replace the hand-rolled `detectOs`/`detectBrowser` regexes
   (`apps/server/src/visits/platform.ts`) with `ua-parser-js`.** `platform`
   (android/ios/desktop) stays on the existing regex — it's a `NOT NULL`
   Postgres enum that live rule-matching depends on (`{type: "platform",
   value: "android"}` routes real traffic), and swapping it would mean
   writing new translation logic from ua-parser-js's richer
   `os.name`/`device.type` output back down to exactly 3 buckets, with no
   accuracy upside (the nuance ua-parser-js adds gets thrown away by that
   collapse) and a real, if narrow, chance of introducing a new
   disagreement on an edge case a translation layer didn't anticipate (e.g.
   a ChromeOS device running an Android app, which ua-parser-js deliberately
   classifies as `"Chromium OS"`, not `"Android"`). OS and browser are pure
   analytics fields — no redirect ever depends on their exact value — so
   there's real accuracy to gain there (many more distinct, recognisable
   values: proper browser names, more OS variants) with none of that risk.

2. **Surface what type of bot hit a link.** `isbot` (already a dependency)
   only returns a boolean today. Verified directly against
   `apps/server/node_modules/isbot/index.d.ts` that it already exports
   `findBotMatch(userAgent): string | null` — the literal substring of the
   UA that matched a bot pattern. For a named bot this is already
   recognisable (`"googlebot"`, `"facebookexternalhit"`, `"Slackbot"`); for
   an obscure/unlisted one it falls back to a generic term (`"crawl"`,
   `"spider"`, `"bot"`). Decided: use this — zero new dependency — rather
   than adding a dedicated crawler-name dataset. Decided: give it full
   parity with OS/browser (own column, rollup dimension, filter, chartable
   `groupBy`) rather than just a label, to avoid the same "log it first, get
   asked to make it filterable/chartable next" two-step that OS/browser went
   through (Plan 20 → Plan 21).

`ua-parser-js` is not currently installed anywhere in this repo (confirmed
by searching all `node_modules` and lockfiles) — the only copy on disk is an
old (v1.0.35) vendored copy inside Next.js's own compiled internals, not an
importable dependency. It needs a fresh `bun add ua-parser-js` in
`apps/server`, and its exact import shape (`UAParser` class vs. named
sub-exports, v1 vs. v2 API) should be confirmed from its own shipped
`.d.ts` once installed rather than assumed — noted as a small
implementation-time check, not a blocker.

## Part A — `ua-parser-js` for OS and browser

1. **`apps/server/package.json`** — add `ua-parser-js` as a dependency.

2. **`apps/server/src/visits/platform.ts`** — rewrite `detectOs`/
   `detectBrowser` to delegate to `UAParser(userAgent ?? "").getResult()`,
   reading `.os.name` / `.browser.name`, lowercased, `null` when empty.
   `detectPlatform` is untouched. Example shape (verify exact import/API at
   implementation time against the installed version's `.d.ts`):

   ```ts
   import { UAParser } from "ua-parser-js" // or default import — confirm from installed .d.ts

   export function detectOs(userAgent: string | null | undefined): string | null {
     if (!userAgent) return null
     const name = UAParser(userAgent).getResult().os.name
     return name ? name.toLowerCase() : null
   }

   export function detectBrowser(userAgent: string | null | undefined): string | null {
     if (!userAgent) return null
     const name = UAParser(userAgent).getResult().browser.name
     return name ? name.toLowerCase() : null
   }
   ```

3. **`packages/shared/src/primitives.ts`** — ua-parser-js's vocabulary is
   open-ended (dozens of OS/browser names, not the current 6/7-item lists),
   so the closed enums no longer fit. Remove `OS_VALUES`/`osSchema` and
   `BROWSER_VALUES`/`browserSchema`; change `Os`/`Browser` from a closed
   union to a plain `string` alias (kept as named types for signature
   clarity, not removed outright):

   ```ts
   export type Os = string
   export type Browser = string
   ```

   `PLATFORMS`/`Platform`/`platformSchema` are untouched (Part A doesn't
   touch platform).

4. **`packages/shared/src/visits.ts`** — `visitListQuerySchema`'s `os`/
   `browser` filters switch from `osSchema.optional()`/`browserSchema.optional()`
   to `z.string().min(1).toLowerCase().optional()` — lowercased at the schema
   boundary so a filter value matches regardless of how it's typed, since the
   stored value is always lowercase (§2). `platform` stays on `platformSchema`.

5. **`apps/server/src/http/api/visits.ts`** — the `row.os as Os | null` /
   `row.browser as Browser | null` casts in `toVisit()` (added in Plan 21 to
   bridge the closed `Os`/`Browser` types against a plain-text DB column) are
   no longer needed once `Os`/`Browser` are plain `string` — drop them,
   `row.os`/`row.browser` already type as `string | null`.

6. **`apps/client/components/visits-card.tsx`** — the OS and Browser filters
   change from a closed `Picker` dropdown (populated from the now-removed
   `OS_VALUES`/`BROWSER_VALUES`) to a plain free-text `Input`
   (`@/components/ui/input`, already used elsewhere in this codebase),
   committed on blur/Enter — matching how an open-ended value should be
   filtered, since a fixed dropdown can no longer represent ua-parser-js's
   real range of values. The `platform` `Picker` (still a closed 3-value
   enum) is untouched.

7. **`apps/server/test/redirect.test.ts`** — the existing table-driven test
   (`"records the platform, os and browser each user agent implies"`, added
   in Plan 20/21) asserts exact literal values (`"macos"`, `"windows"`,
   `"chrome"`, `"safari"`) for its `ANDROID`/`IPHONE`/`DESKTOP` fixture UAs.
   ua-parser-js's real output strings for these common, mainstream UAs need
   to be confirmed by actually running it (expected to be very close —
   e.g. `"Mac OS"` rather than `"macos"` before lowercasing, so the test's
   expected values likely need updating to whatever the library actually
   returns, lowercased) — this is a run-it-and-adjust step, not a
   pre-verified certainty.

## Part B — bot type/name

1. **`apps/server/src/visits/bot.ts`** — add, next to `detectBot`:

   ```ts
   import { findBotMatch, isbot } from "isbot"

   /**
    * What isbot's own pattern match actually was — often already recognisable
    * (`"googlebot"`, `"facebookexternalhit"`, `"slackbot"`), sometimes a
    * generic term (`"crawl"`, `"spider"`) for an obscure or unlisted bot.
    * Lowercased so the same bot family never fragments into two buckets by
    * casing alone (some real UAs capitalise their own name differently) —
    * the same reasoning `os`/`browser` already lowercase on. Null for a
    * human, and for a bot flagged only by having no User-Agent at all —
    * nothing to match against in that case.
    */
   export function detectBotLabel(userAgent: string | null | undefined): string | null {
     return findBotMatch(userAgent)?.toLowerCase() ?? null
   }
   ```

   `detectBot` itself is untouched (still the existing boolean, still tested
   by the existing `describe("detectBot", ...)` block) — this is additive.

2. **`apps/server/src/db/schema.ts`** — add `botLabel: text("bot_label")`
   to the `visits` table (nullable, plain text — same shape as `os`/
   `browser`), and `"botLabel"` to `visitDimensionEnum`.

3. **New migration** `apps/server/drizzle/00XX_visit_bot_label.sql`
   (generate via `bun run db:generate`, then hand-append the trigger
   rewrite, same two-part convention as `0011`/`0012`):

   ```sql
   ALTER TABLE "visits" ADD COLUMN "bot_label" text;--> statement-breakpoint
   ALTER TYPE "public"."visit_dimension" ADD VALUE 'botLabel' BEFORE 'referer';--> statement-breakpoint
   -- No backfill, same call 0011/0012 made: only a future visit is counted
   -- under this dimension.
   CREATE OR REPLACE FUNCTION record_visit_rollup() RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE
     d date := (new.occurred_at AT TIME ZONE 'UTC')::date;
   BEGIN
     INSERT INTO "visit_days" ("day", "domain_id", "link_id", "dimension", "value", "is_bot", "count")
     SELECT d, new.domain_id, new.link_id, dims.dim, dims.val, new.is_bot, 1
     FROM (VALUES
       ('total'::visit_dimension,       ''::text),
       ('platform'::visit_dimension,    new.platform::text),
       ('os'::visit_dimension,          coalesce(new.os, '')::text),
       ('browser'::visit_dimension,     coalesce(new.browser, '')::text),
       ('botLabel'::visit_dimension,    coalesce(new.bot_label, '')::text),
       ('referer'::visit_dimension,     coalesce(new.referer, '')::text),
       ('destination'::visit_dimension, coalesce(new.destination, '')::text),
       ('slug'::visit_dimension,        new.slug_requested::text)
     ) AS dims(dim, val)
     ON CONFLICT ("day", "domain_id", "link_id", "dimension", "value", "is_bot")
       DO UPDATE SET "count" = "visit_days"."count" + 1;

     INSERT INTO "visit_counts" ("domain_id", "link_id", "human", "bot", "last_visit_at")
     VALUES (
       new.domain_id, new.link_id,
       CASE WHEN new.is_bot THEN 0 ELSE 1 END,
       CASE WHEN new.is_bot THEN 1 ELSE 0 END,
       new.occurred_at
     )
     ON CONFLICT ("domain_id", "link_id") DO UPDATE SET
       "human" = "visit_counts"."human" + excluded."human",
       "bot" = "visit_counts"."bot" + excluded."bot",
       "last_visit_at" = greatest("visit_counts"."last_visit_at", excluded."last_visit_at");

     RETURN NULL;
   END $$;
   ```

4. **`apps/server/src/http/redirect.ts`** — the `visit` object literal gains
   `botLabel: detectBotLabel(userAgent)`.

5. **`packages/shared/src/visits.ts`** — `GROUP_BY` gains `"botLabel"`;
   `visitListQuerySchema` gains `botLabel: z.string().min(1).toLowerCase().optional()`
   (same lowercase-at-the-boundary treatment as `os`/`browser`); `Visit`
   type gains `botLabel: string | null`.

6. **`apps/server/src/http/api/visits.ts`** — `toVisit()` maps
   `botLabel: row.botLabel`; `visitFilters()` gains
   `if (q.botLabel) filters.push(eq(visits.botLabel, q.botLabel))`.

7. **`apps/client/components/stats-panel.tsx`** — `GROUP_LABELS` gains
   `botLabel: "Bot type"`.

8. **`apps/client/components/visits-card.tsx`**:
   - The existing "Bot" badge cell shows the label when present, instead of
     always saying "Bot":
     `visit.isBot ? <Badge variant="outline">{visit.botLabel ?? "Bot"}</Badge> : null`
     — reuses the existing slot rather than adding a column that would be
     empty for the ~90%+ of rows that are human visits.
   - A free-text "Bot type" `Input` filter, same shape as the OS/Browser
     inputs from Part A §6 (open vocabulary, same reasoning).

9. **Tests**:
   - `apps/server/test/redirect.test.ts`: a request with a known bot UA
     (e.g. reuse the existing `BOT` fixture, `"...Googlebot/2.1..."`) records
     a recognisable `botLabel` (`"googlebot"`); a human visit's `botLabel` is
     `null`.
   - `apps/server/test/stats.test.ts`: `groupBy=botLabel` buckets correctly,
     mirroring the existing `groupBy=os`/`groupBy=browser` test added in
     Plan 21. The existing "bad groupBy" test already uses `groupBy=country`
     (fixed in Plan 21 precisely because `browser` stopped being invalid) —
     unaffected by this addition.

## Sequencing

Parts A and B are independent — either order works. Within each part, code
before its migration/test, same as every prior plan here.

## Verification

```
bun run db:generate   # for Part B's migration
bun test apps/server/test/redirect.test.ts apps/server/test/stats.test.ts
bun run test
bun run typecheck
```

Manual, against the local docker stack (mirroring how Plans 20–22 were each
verified live): click a link with a normal browser and confirm OS/browser
still populate sensibly; hit a link with a known crawler UA (e.g.
Googlebot's or Slackbot's real UA string via curl) and confirm `botLabel`
comes back recognisable in `/api/v1/visits`; confirm `groupBy=botLabel`
buckets a few such hits together.

## Risks

- ua-parser-js's exact import shape/version needs a short confirmation at
  implementation time (not verified from files, since it isn't installed
  yet) — flagged, not a blocker.
- No backfill anywhere in this plan (OS/browser's existing stored values
  from the old regex, and every visit before the bot-label migration) — same
  forward-only stance every prior plan in this repo has taken; historical
  rows keep whatever they already have.
- Bot naming quality is only as good as isbot's own pattern list — an
  obscure/unlisted bot shows a generic term (`"crawl"`, `"spider"`) instead
  of a proper name. Accepted per the earlier decision to avoid a new
  dependency for this.
- Switching OS/Browser filters from a dropdown to free text is a real UX
  change (typo-prone, no autocomplete) — the honest tradeoff of the
  vocabulary becoming genuinely open-ended; not something a dropdown could
  represent correctly any more.
