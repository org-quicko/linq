# linq — Plan 34: the Analytics page, and retiring the old report API

Follows `plans/Plan_33.md`, which built `/api/v1/analytics/{summary,
timeseries,breakdown}` and left the old report routes standing so the Client
UI kept working. This plan moves the client onto the new API, builds the
filtering interaction it was written for, and then deletes what it replaced.

**Do not start this before Plan_33's benchmark gate has been settled.** If
that gate changed Plan_33's shape, the endpoint contract this plan consumes
may have moved with it.

---

## Context

`/analytics` today is three stacked things: an overview matching the intended
design, and below it two legacy sections — a "Traffic" stats panel with a raw
visit "Log", and a "Missed links" panel with "Missed requests" — each with
its own independent filters (`apps/client/app/analytics/page.tsx:39-93`).

The overview's breakdown rows are inert. `analytics-overview.tsx:31-34` says
why: there was no server-side filter to call. Plan_33 built one.

## What's being built

1. Breakdown rows become filters. Clicking one narrows the whole page;
   several stack; removing them restores the page exactly.
2. The date range loses "All time" and gains a custom range capped at one
   year, handled on the interface rather than as a server error.
3. The page is reduced to the overview. The two legacy sections go, and with
   them `stats-panel.tsx`, `visits-card.tsx`, `lib/store/visits.ts` and the
   `recharts` dependency.
4. The superseded server routes, schemas, tests and OpenAPI entries are
   deleted.

## A. The interaction being built

Stated as requirements, since the page is being described rather than
transcribed:

**Header.** The page title, and beside it one chip per active filter.
Each chip reads `<Dimension>: <value>` — `Referrer: google.com`,
`OS: windows`, `Browser: chrome`, `Device: desktop` — and carries an `×` that
removes that filter and leaves the others. Right-aligned: the link combobox
(single-select, searchable, clearable) and the date-range button.

**Stat cards**, in a row: Total visits; Human with its percentage; Bot with
its percentage; Orphan clicks. The orphan card is hidden whenever a link
filter is active — an orphan visit resolved to no link, so per-link orphan
traffic does not exist.

**Visits over time.** A single-series smoothed area chart of total visits —
the human/bot split lives in the cards above, not in the trend. Each day gets
an invisible full-height hover column; hovering reveals that day's dot and a
tooltip with its date and count. Nothing is shown until hovered. The first
and last date labels sit under the chart.

**Two breakdown cards**, side by side: Referrers, and Devices. The Devices
card carries a plain text-and-chevron selector (not a bordered button)
switching it between Type, Browser and OS.

**Breakdown rows are meters.** Each row's background fills proportionally to
the top row's value; an icon and a truncating label sit on the left, the
count on the right. Clicking a row applies that value as a filter. Clicking
an active row removes it. A card whose dimension has active filters collapses
to just the selected rows; the other card keeps its full list, recomputed for
the narrowed segment.

**Date range.** A dropdown with three presets — 7, 30, 90 days — each with a
check when selected, plus a "Custom range" entry that opens an inline panel
inside the same menu: two date inputs and an Apply button.

## B. Range — `lib/hooks.ts`, `components/common.tsx`

`RANGES` loses `{ value: "0", label: "All time" }` and keeps 7 / 30 / 90.
`useRange` gains a custom mode and now yields a `to` as well as a `from`:

```ts
export function useRange(initial: Range = "7") {
  const [preset, setPreset] = useState<Range | "custom">(initial)
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null)
  const window = useMemo(
    () => (preset === "custom" && custom ? custom : presetWindow(preset)),
    [preset, custom],
  )
  return { preset, custom, setPreset, setCustom, ...window, label: rangeLabel(preset, custom) }
}
```

The warning at `hooks.ts:31-42` is load-bearing and still applies: everything
memoises on `[preset, custom]` and the clock is read **inside** the memo,
never per render — a fresh `Date.now()` in an RTK Query arg is an endless
refetch loop. Consequence: a page left open across UTC midnight keeps
yesterday's window until something else re-renders it. Acceptable, noted so
it is not mistaken for a bug.

`presetWindow`, `rangeLabel` and the span clamp are plain functions in
`lib/hooks.ts`, outside the hook, so §G can test them without React.

`RangePicker` (`common.tsx:433-448`) is rebuilt on `DropdownMenu` rather than
`Picker`/`Select`, because a Radix `Select` cannot hold the inline
custom-range panel:

- trigger: `Button variant="outline"` showing a preset name, or `Sep 1 –
  Sep 18` for a custom range;
- three preset items, each with a `Check` when selected;
- a "Custom range" item with `onSelect={(e) => e.preventDefault()}` so the
  menu stays open, revealing two native `<input type="date">` and an Apply
  button, `max` = today and `min` = today − 365 days;
- Apply disabled while the pair is incomplete, inverted, or more than a year
  apart, with an inline "Pick a range of one year or less". The cap is
  handled on the interface and never reaches the reader as a 400 — though
  Plan_33's server-side refusal stays as the backstop.

Native date inputs rather than a calendar component: `components/ui` has no
`calendar` and no `date-picker`, and `link-form-dialog.tsx:283` already sets
the precedent with `<input type="datetime-local">`.

## C. Store — `lib/store/stats.ts`

`getStats` (a single `{ path, params }` passthrough) is replaced by
`getAnalyticsSummary`, `getAnalyticsTimeseries` and `getAnalyticsBreakdown`,
all `providesTags: ["Stats"]`, all building their query string with `qs()`.
`qs` already drops empty values, so an empty filter list omits its param with
no extra handling. `listTags` stays where it is.

## D. `components/analytics-overview.tsx`

```ts
type Segment = { dim: "referer" | "os" | "browser" | "platform"; value: string }
```

- State is `link_id` plus `segments: Segment[]` — an array, so filters stack.
  Two segments on the same dimension widen it (OR); two on different
  dimensions narrow (AND), matching Plan_33 §F.
- Mirrored to the URL as `?link_id=…&referer=a,b&os=windows`, read once into
  `useState` on mount and pushed back with `router.replace` on change — the
  shape `:38-80` already uses for `?link_id=`. `useSearchParams` stays inside
  the `<Suspense>` boundary at `app/analytics/page.tsx:27`, which the static
  export requires.
- The params object is built in a `useMemo` keyed on
  `[from, to, link_id, segments]`, CSV joins included, so RTK Query's
  serialised arg key is stable.
- Removing the last segment returns the page to its original state exactly,
  because the state *is* the segment list — there is no separate "unfiltered"
  code path to drift.
- Chips use the removable-chip markup that already exists at
  `tag-picker.tsx:131-149`.
- Breakdown rows become `<button type="button">`.
- The `''` bucket renders as "Direct" for referrers and "(not recorded)"
  elsewhere, and **is clickable**: the segment carries `NOT_RECORDED` on the
  wire and the server maps it back to `''`. Without that, Direct traffic —
  usually the largest single row — would be the one row that cannot be
  filtered on.
- Every clickable row, chip and `×` carries `cursor-pointer`; shadcn
  primitives default to `cursor-default`.
- The Devices card's selector is unchanged; the `dim` it filters on is
  whichever view is showing, so referrer + device type + OS + browser can all
  be active at once.
- The four `useGetStatsQuery` calls (`:52-60`) become one `summary`, one
  `timeseries` and two `breakdown`s; the separate orphan query at `:53-56`
  disappears into `summary`.

`fillDays` and `MAX_DAYS` move here from the deleted `stats-panel.tsx`.
`MAX_DAYS = 90`'s `.slice(-90)` (`:162`) has to go — with a one-year range it
would silently truncate the chart rather than showing less detail. Replace it
with a fold: above ~120 points, group days into ISO weeks and label each
bucket by its first day. `fillDays` runs first so the weeks are dense; the
fold is a `reduce` over its output, and the tooltip then reads "week of
Sep 1". Budget it as real work, not a one-liner — it is the piece most likely
to be fiddlier than it looks.

## E. `app/analytics/page.tsx`

Drops `VisitsSection` (`:39-57`) and `OrphansSection` (`:66-93`) entirely.
The page becomes the header plus `<Suspense><AnalyticsOverview /></Suspense>`,
and adopts the links page's pinned-header layout (`app/links/page.tsx:119`
`shrink-0` header, `:198` `min-h-0 flex-1 overflow-y-auto` body) so the
filter row and chips stay put while the cards scroll — today the whole column
scrolls (`:23`).

## F. Deletions

**Client** — each verified by grep as having exactly one importer:

- `components/stats-panel.tsx`, `components/visits-card.tsx` —
  `app/analytics/page.tsx` is the only importer of either.
- `lib/store/visits.ts` — `useListVisitsQuery`'s only caller is
  `visits-card.tsx:60`.
- `recharts` from `apps/client/package.json:25` — `stats-panel.tsx:16` is its
  only importer in the repo. The surviving chart is the hand-written SVG at
  `analytics-overview.tsx:153-225`.
- `fromInstant` from `useRange` — only `visits-card.tsx:51` read it.
- Check `app/dev/components/page.tsx` renders nothing deleted (its
  `TabShell`/`DomainPicker` mentions at `:28`, `:40-42` are docblock prose;
  `DomainPicker` survives via `app/links/page.tsx:165`).

**Server** — only now that nothing calls them:

- `apps/server/src/http/api/stats.ts`. `aggregateVisits` and `dayFilters`
  move into `analytics.ts`, which has been importing them since Plan_33 §F.
- `apps/server/src/http/app.ts:19`, `:91`, `:94`, `:96` — import and three
  mounts.
- `packages/shared/src/visits.ts` — `GROUP_BY`, `GroupBy`,
  `statsQuerySchema`, `globalStatsQuerySchema`, and their re-exports from
  `index.ts`. `StatsBucket`, `Visit` and `visitListQuerySchema` stay.
- `apps/server/test/stats.test.ts` — deleted; `analytics.test.ts` covers this
  ground.
- `apps/server/test/purge.test.ts:22` — its `totalVisits()` helper calls
  `/api/v1/stats` and the purge assertions depend on it. Repoint at
  `/api/v1/analytics/summary`.
- `resources/openapi/linq.openapi.json` — remove the three `…/stats` path
  items (`:390`, `:951`, `:1211`) and the `StatsFrom` / `StatsTo` / `GroupBy`
  parameter components.

`GET /v1/visits` stays. It is the only way to read a user agent, a query
string or an exact instant; the page for it is gone, the endpoint is not.

The client and server deletions are one commit's worth of coupling: root
`test` runs `apps/client/test` and `typecheck` is `tsc -b` over the
workspace, so removing the shared schemas before §C/§D land leaves both red.

## G. Tests

`apps/client/test/range.test.ts` — `presetWindow`, `rangeLabel`, the
one-year clamp, and the ISO-week fold from §D, all as plain functions.

There is no component test harness in this repo (`apps/client/test` is
`qr.test.ts` and `servers.test.ts`) and this plan does not add one.
**That is a known gap, not an oversight**: the segment state machine, the URL
round-trip and the collapse behaviour are the most intricate things here and
they will be covered only by the manual pass in §Verification. If that is not
acceptable, adding a component harness is its own decision and its own plan.

Server-side, `analytics.test.ts` already exists from Plan_33 and needs no
change beyond surviving the deletions in §F.

## Files

- `apps/client/components/analytics-overview.tsx` — the bulk of the work
- `apps/client/app/analytics/page.tsx` — reduced to the overview
- `apps/client/lib/hooks.ts`, `apps/client/components/common.tsx` — range
- `apps/client/lib/store/stats.ts` — three endpoints
- deleted: `apps/client/components/stats-panel.tsx`,
  `apps/client/components/visits-card.tsx`, `apps/client/lib/store/visits.ts`
- `apps/client/package.json` — drop `recharts`
- `apps/client/test/range.test.ts` — new
- `apps/server/src/http/api/stats.ts` — deleted
- `apps/server/src/http/api/analytics.ts` — absorbs the two moved helpers
- `apps/server/src/http/app.ts`, `apps/server/test/purge.test.ts`
- deleted: `apps/server/test/stats.test.ts`
- `packages/shared/src/visits.ts`, `packages/shared/src/index.ts`
- `resources/openapi/linq.openapi.json`

## Sequencing

1. §B — range hook and picker, with §G's tests.
2. §C — the three store endpoints.
3. §D — the overview: segments, chips, clickable rows, the week fold.
4. §E — the page reduced to the overview.
5. §F client deletions, then §F server deletions, then the OpenAPI edit.

Steps 1–4 leave the old endpoints untouched and reversible. Step 5 is the
point of no return.

## Verification

- `bun run test`, `bun run typecheck`, `bun run lint`.
- `grep -rn recharts apps/client` returns only `package.json` before removing
  it, and nothing after.
- Manually, via the `linq-dev` skill: create a few links, hit them from
  different browsers and devices so `os`, `browser`, `platform` and `referer`
  differ, then on `/home/analytics/`:
  - click a referrer row → chip appears, cards, chart and the Devices card
    all narrow to that segment, the Referrers card collapses to that row;
  - click an OS row on top of it → two chips, both cards collapsed, numbers
    narrow again;
  - add a browser → all three stack;
  - click a second referrer → the referrer filter widens rather than
    replacing, and the count goes up;
  - remove one chip → that dimension reopens, the others hold;
  - remove all → identical to the starting page;
  - reload with chips active → the URL restores them;
  - click the "Direct" referrer row → it filters like any other;
  - select a link → the orphan card disappears;
  - pick a custom range over a year → Apply stays disabled with the inline
    message, no request is made;
  - pick a 300-day custom range → the chart folds to weeks and stays legible.
- Confirm no request in the network panel goes to `/v1/stats`,
  `/v1/links/:id/stats` or `/v1/domains/:id/stats` before deleting them.

## Risks

- **The intricate logic is untested** (§G). The manual pass is the only
  coverage for the segment state machine and the URL round-trip.
- **The week fold is the soft estimate here.** It interacts with `fillDays`,
  the tooltip labels and the axis labels, and it is the one piece with no
  existing code to copy.
- **Breaking API change.** Three published endpoints disappear. This is the
  instance's own Client UI on an API-key-only surface, and it is an explicit
  decision rather than a side effect — but anyone scripting against
  `/v1/stats` is broken at step 5.
- **URL state is a one-way mirror.** The URL seeds state on mount and is
  written on change; it is not a live binding. Browser back will not step
  through filter history. Matches what the page already does for `?link_id=`,
  and changing it is a bigger job than this plan.
- **`GET /v1/visits` loses its only UI.** The endpoint survives, but nothing
  in the app exercises it any more, so regressions in it will go unnoticed
  until someone calls it directly.
