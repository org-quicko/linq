# linq — Plan 29: remove bot name and type capture and filters

Follows `docs/plans/Plan_28.md` and `docs/plans/Plan_24.md`.

## Context

In `docs/plans/Plan_24.md`, bot name/type identification (`botLabel`) was introduced using `isbot`'s `findBotMatch(userAgent)` to record specific bot identifiers (e.g., `"googlebot"`, `"facebookexternalhit"`), along with a `bot_label` column on `visits`, a `"botLabel"` dimension in `visitDimensionEnum` and `visit_days` rollups, a `botLabel` query filter, and a "Bot type" filter input and badge in the UI.

In practice, bot names and types captured this way are unreliable and inconsistent across diverse user agents (frequently returning internal regex patterns, fragments like `"crawl"` or `"bot"`, or null despite being detected as a bot). Furthermore, grouping by `botLabel` generates fragmented, low-utility analytics buckets.

The requirement is to remove the bot name and type capture and remove the filters for it at the moment.

> [!NOTE]
> High-level bot detection (`isBot` boolean: distinguishing humans from crawlers/bots), human vs. bot traffic counts (`humanVisits` / `botVisits`), and the overall bot filter (`bot: "any" | "true" | "false"`) remain completely intact. Only the granular bot name/type classification (`botLabel`) is removed.

---

## Architecture & Design Decisions

### 1. Removing Capture at Ingest
- In `apps/server/src/visits/bot.ts`: remove `detectBotLabel(userAgent)` and the unused `findBotMatch` import from `isbot`.
- In `apps/server/src/http/redirect.ts`: stop populating `botLabel` in the visit payload recorded during short link redirects.

### 2. Database Schema & Migration Strategy
Following the precedent in `docs/adr/0010` and `apps/server/drizzle/0006_drop_geolocation.sql`:
- PostgreSQL does not support `ALTER TYPE ... DROP VALUE`. Therefore, removing `"botLabel"` from `visit_dimension` requires:
  1. Deleting rows from `visit_days` where `dimension = 'botLabel'`.
  2. Casting `visit_days.dimension` to `text`.
  3. Dropping `public.visit_dimension`.
  4. Re-creating `public.visit_dimension AS ENUM('total', 'platform', 'os', 'browser', 'referer', 'destination', 'slug')`.
  5. Casting `visit_days.dimension` back to `visit_dimension`.
  6. Updating `record_visit_rollup()` trigger function to remove the `'botLabel'` row insertion.
  7. Dropping column `bot_label` from `visits`.
- Update `apps/server/src/db/schema.ts` to remove `botLabel` from `visits` and from `visitDimensionEnum`.

### 3. API & Shared Schema Cleanup
- **`packages/shared/src/visits.ts`**:
  - Remove `"botLabel"` from `GROUP_BY` constant.
  - Remove `botLabel: openFilter` from `visitListQuerySchema`.
  - Remove `botLabel: string | null` from `Visit` type.
- **`apps/server/src/http/api/visits.ts`**:
  - Remove `botLabel: row.botLabel` mapping in `toVisit()`.
  - Remove `botLabel` filtering logic in `visitFilters()`.

### 4. Client UI Cleanup
- **`apps/client/components/visits-card.tsx`**:
  - Remove `botLabel` state (`useState("")`) and remove `botLabel` param from `useListVisitsQuery`.
  - Remove the "Bot type" `Input` filter from the header toolbar.
  - In the table row, render `<Badge variant="outline">Bot</Badge>` for bot visits rather than displaying `visit.botLabel`.
- **`apps/client/components/stats-panel.tsx`**:
  - Remove `botLabel: "Bot type"` from `GROUP_LABELS`.
- **`apps/client/lib/store/visits.ts`**:
  - Remove `botLabel?: string` from query argument types.

### 5. Automated Tests
- In `apps/server/test/redirect.test.ts`:
  - Remove test asserting `botLabel` extraction.
- In `apps/server/test/stats.test.ts`:
  - Remove `botLabel` grouping tests (`groupBy=botLabel`) and `botLabel` visit filter tests.
- Verify full test suite passes with `bun test`.

---

## Sequencing

1. Update `apps/server/src/db/schema.ts`.
2. Generate migration `0017_drop_bot_label.sql` and update journal/metadata.
3. Update `apps/server/src/visits/bot.ts` and `apps/server/src/http/redirect.ts`.
4. Update `packages/shared/src/visits.ts` and `apps/server/src/http/api/visits.ts`.
5. Update client components (`visits-card.tsx`, `stats-panel.tsx`, `lib/store/visits.ts`).
6. Update server unit tests (`redirect.test.ts`, `stats.test.ts`).
7. Run `bun test` and `bun run build:client` to verify end-to-end.

