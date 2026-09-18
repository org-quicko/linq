# linq — Plan 21: filter and chart visits by OS and browser too

Follows `plans/Plan_20.md`.

## Context

Plan 20 captured `os`/`browser` per visit and surfaced them in the Log as one
combined "Device" cell. Two things it explicitly deferred are exactly what's
being asked for now, from the two screenshots:

1. The Log table should show **Platform, OS and Browser as three separate
   columns**, and the Log's filters should narrow by any of the three, the
   same way it already narrows by human/bot and date range.
2. The **Traffic chart's "group by" picker** (currently Day / Platform /
   Referrer / Destination / Requested slug) should offer OS and Browser too,
   so "60% Chrome, 25% Firefox…" is chartable the same way "60% desktop, 30%
   android…" already is.

This is the "Stats/report parity" work `plans/Plan_20.md` flagged as
deferred and named as a candidate Plan 21.

`detectOs`/`detectBrowser` (`apps/server/src/visits/platform.ts`) can only
ever produce one of a fixed handful of strings. Rather than let the client's
filter dropdowns and the server's detector drift independently, both read
from one shared list — the same way `platform` already does via `PLATFORMS`
in `packages/shared/src/primitives.ts`.

**A pre-existing test breaks under this plan and must be fixed as part of
it**: `apps/server/test/stats.test.ts:152` currently uses `groupBy=browser`
as its example of an *invalid* groupBy, to assert a 400. Once `browser`
becomes a real dimension, that request would start succeeding and the test
would silently stop testing anything.

## 1. `packages/shared/src/primitives.ts`

Add, next to `PLATFORMS`/`platformSchema`, in the same detector-order (most
specific check first — not load-bearing, just keeps the two readable
side by side):

```ts
export const OS_VALUES = ["android", "ios", "macos", "windows", "chromeos", "linux"] as const
export type Os = (typeof OS_VALUES)[number]
export const osSchema = z.enum(OS_VALUES)

export const BROWSER_VALUES = [
  "edge",
  "opera",
  "samsung-internet",
  "firefox",
  "chrome",
  "safari",
  "ie",
] as const
export type Browser = (typeof BROWSER_VALUES)[number]
export const browserSchema = z.enum(BROWSER_VALUES)
```

## 2. `apps/server/src/visits/platform.ts`

Tighten `detectOs`/`detectBrowser`'s return type from `string | null` to
`Os | null` / `Browser | null` (import `Os, Browser` from `@linq/shared`).
No logic change — the literals they already return are exactly the members
of `OS_VALUES`/`BROWSER_VALUES`; this only makes the compiler enforce that
stays true.

## 3. `packages/shared/src/visits.ts`

- `GROUP_BY` (line 4): add `"os"`, `"browser"`.
- `visitListQuerySchema` (line 26): add three optional filters, reusing the
  same closed vocabularies (import `platformSchema`, `osSchema`,
  `browserSchema` from `./primitives.ts` alongside the existing imports):

```ts
export const visitListQuerySchema = paginationSchema.extend({
  ...scope,
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  bot: z.enum(["true", "false", "any"]).default("any"),
  platform: platformSchema.optional(),
  os: osSchema.optional(),
  browser: browserSchema.optional(),
})
```

- `Visit` type (line 57–59): tighten `platform`/`os`/`browser` to the shared
  types (`Platform`, `Os | null`, `Browser | null`) instead of the hand-rolled
  union/`string | null`, importing `Platform` alongside `Os`/`Browser`.

## 4. `apps/server/src/db/schema.ts`

`visitDimensionEnum` gains `"os"`, `"browser"`:

```ts
export const visitDimensionEnum = pgEnum("visit_dimension", [
  "total",
  "platform",
  "os",
  "browser",
  "referer",
  "destination",
  "slug",
])
```

## 5. New migration `apps/server/drizzle/0012_visit_dimensions_os_browser.sql`

Postgres allows `ALTER TYPE ... ADD VALUE` without the drop-and-rebuild dance
`0006` needed for *removing* a value. Verified directly against this stack's
local Postgres 17 that a value added earlier in a transaction can be
referenced from a function body `CREATE OR REPLACE`d later in that same
transaction without error — the body isn't evaluated until a later,
separate transaction calls the function — so this is one migration file, not
two:

```sql
-- os/browser join platform as chartable dimensions, the same way platform
-- itself already is. See plans/Plan_21.md.
ALTER TYPE "visit_dimension" ADD VALUE 'os';--> statement-breakpoint
ALTER TYPE "visit_dimension" ADD VALUE 'browser';--> statement-breakpoint
-- No backfill, same call 0011 made for the columns these dimensions roll up
-- from: only a future visit is counted under either one.
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
    ('referer'::visit_dimension,     coalesce(new.referer, '')::text),
    ('destination'::visit_dimension, coalesce(new.destination, '')::text),
    ('slug'::visit_dimension,        new.slug_requested::text)
  ) AS dims(dim, val)
  ON CONFLICT ("day", "domain_id", "link_id", "dimension", "value", "is_bot")
    DO UPDATE SET "count" = "visit_days"."count" + 1;

  INSERT INTO "visit_counts" ("domain_id", "link_id", "human", "bot", "last_visit_at")
  VALUES (
    new.domain_id,
    new.link_id,
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

Run `bun run db:generate` after step 4, confirm drizzle-kit proposes exactly
the two `ADD VALUE` statements (it won't touch the trigger function — it has
no model for it), then hand-append the `CREATE OR REPLACE FUNCTION` block
above, following the same two-part convention `0006`/`0010`/`0011` used.

Rows already in `visit_days` from before this migration were never in the
`os`/`browser` dimension to begin with (it didn't exist yet), so there's
nothing to touch there either.

## 6. `apps/server/src/http/api/visits.ts`

`visitFilters()`'s inline parameter type and body both gain the three new
fields, same shape as the existing ones:

```ts
function visitFilters(q: {
  from?: string
  to?: string
  bot?: "true" | "false" | "any"
  linkId?: string
  domainId?: string
  orphan?: "true" | "false"
  platform?: Platform
  os?: Os
  browser?: Browser
}): SQL[] {
  const filters: SQL[] = []
  if (q.from) filters.push(gte(visits.occurredAt, new Date(q.from)))
  if (q.to) filters.push(lte(visits.occurredAt, new Date(q.to)))
  if (q.bot && q.bot !== "any") filters.push(eq(visits.isBot, q.bot === "true"))
  if (q.linkId) filters.push(eq(visits.linkId, q.linkId))
  if (q.domainId) filters.push(eq(visits.domainId, q.domainId))
  if (q.orphan === "true") filters.push(isNull(visits.linkId))
  if (q.platform) filters.push(eq(visits.platform, q.platform))
  if (q.os) filters.push(eq(visits.os, q.os))
  if (q.browser) filters.push(eq(visits.browser, q.browser))
  return filters
}
```

(`Platform`, `Os`, `Browser` imported from `@linq/shared`.) This inline type
duplicates `visitListQuerySchema`'s shape a second time — pre-existing in
this file, not introduced here, just grown by three fields; see Risks.

## 7. `apps/client/lib/store/visits.ts`

`VisitFilters` gains, reusing the same shared types the schema does:

```ts
import type { Browser, Os, Page, Platform, Visit } from "@linq/shared"

export type VisitFilters = {
  linkId?: string
  domainId?: string
  orphan?: "true"
  bot?: "any" | "true" | "false"
  platform?: Platform
  os?: Os
  browser?: Browser
  from?: string
  limit?: number
  offset?: number
}
```

## 8. `apps/client/components/stats-panel.tsx`

`GROUP_LABELS` (line 19) gains:

```ts
os: "OS",
browser: "Browser",
```

## 9. `apps/client/components/visits-card.tsx`

- Split the single "Device" column (added in Plan 20) back into three, per
  what's being asked for now:

```tsx
const head = [
  "When",
  ...(showSlug ? ["Slug"] : []),
  "Platform",
  "OS",
  "Browser",
  "Referrer",
  "Sent to",
  "",
]
```

```tsx
<TableCell>{visit.platform}</TableCell>
<TableCell>{visit.os ?? "—"}</TableCell>
<TableCell>{visit.browser ?? "—"}</TableCell>
```

- Add three more `Picker`s next to the existing bot Picker — `PLATFORMS`,
  `OS_VALUES`, `BROWSER_VALUES` imported from `@linq/shared`, each with an
  "Any" sentinel (Radix refuses an empty string value, same reason
  `apps/client/app/domains/page.tsx`'s `ANY_DOMAIN` exists):

```tsx
const ANY = "__any__"
const [platform, setPlatform] = useState("")
const [os, setOs] = useState("")
const [browser, setBrowser] = useState("")
```

```tsx
const onPlatform = (value: string) => {
  setPlatform(value === ANY ? "" : value)
  setOffset(0)
}
// onOs, onBrowser: identical shape
```

```tsx
<Picker
  className="w-36"
  value={platform || ANY}
  onChange={onPlatform}
  options={[{ value: ANY, label: "Any platform" }, ...PLATFORMS.map((p) => ({ value: p, label: p }))]}
/>
// Same for OS_VALUES → "Any OS", BROWSER_VALUES → "Any browser"
```

  and thread all three into `useListVisitsQuery`:

```ts
const visits = useListVisitsQuery({
  ...scope,
  bot,
  platform: platform || undefined,
  os: os || undefined,
  browser: browser || undefined,
  from: fromInstant,
  limit: PAGE,
  offset,
})
```

## 10. `apps/server/test/stats.test.ts` — fix the test this plan breaks

Line 152 uses `groupBy=browser` as an example of an invalid value. Swap it
for something that stays invalid after this plan, e.g. `groupBy=country`
(removed as a dimension by `0006`, per `docs/adr/0010`, so it's a real
"never valid" example rather than an arbitrary made-up word):

```ts
const bad = await h.request(`/api/v1/links/${linkId}/stats?groupBy=country`, {
  key: author.key,
})
```

## 11. New tests

- `apps/server/test/stats.test.ts`, next to `"groups by every other
  dimension, busiest first"` (line 100): add `os`/`browser` fixture data (a
  couple more `h.recordVisits(...)` calls with `os`/`browser` overrides —
  the harness's `overrides` param is already `Partial<typeof
  visits.$inferInsert>`, so no helper change is needed) and assert
  `groupBy=os`/`groupBy=browser` bucket the same way `groupBy=platform`
  already does.
- `apps/server/test/stats.test.ts`, in `describe("GET /api/v1/visits")`
  (line 210), next to `"filters humans from bots"` (line 227): a new test
  asserting `?platform=`, `?os=` and `?browser=` each narrow the raw log,
  mirroring that test's shape.

## Sequencing

1. Shared vocabulary (§1–§3).
2. Schema + migration (§4–§5).
3. Server filters (§6).
4. The pre-existing test fix (§10) — do this alongside §5, since that's the
   change that invalidates it.
5. Client (§7–§9).
6. New tests (§11).

## Verification

```
bun run db:generate   # after §4, to confirm the migration shape
bun test apps/server/test/stats.test.ts
bun run test
bun run typecheck
```

Manual: reload the Visits page, confirm the Log table shows Platform/OS/
Browser as three separate columns and that picking e.g. "windows" in the new
filter narrows the rows; open the Traffic chart's group-by picker and
confirm "OS" and "Browser" are listed and draw a sane bar chart.

## Risks

- `ALTER TYPE ... ADD VALUE` inside a transaction that also creates a
  function referencing the new value was verified directly against this
  stack's Postgres 17 (see §5) — not a risk on this stack, called out only
  because it's the kind of thing that silently breaks on an older engine.
- §6 grows a second, hand-written copy of `visitListQuerySchema`'s shape.
  Pre-existing duplication, not introduced by this plan — worth collapsing
  to `z.infer<typeof visitListQuerySchema>` at some point, not done here to
  keep this plan's diff to what was asked for.
- The pre-existing failures already noted in `plans/Plan_20.md`
  (`bootstrap.test.ts`, two in `redirect.test.ts`) are untouched by this plan
  and will still show up in a full `bun run test` run.
