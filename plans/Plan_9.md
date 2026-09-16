# linq — Plan 9: make the analytics chart readable

Follows `plans/Plan_8.md`.

## Context

`apps/client/components/stats-panel.tsx` is the only chart in the app. One generic `StatsPanel` serves all three call sites — `app/overview/page.tsx:39`, `app/orphans/page.tsx:59`, `app/links/detail/page.tsx:92` — by taking a `path` plus a `groupBy` picker.

It is unreadable, for four separate reasons that compound:

1. **Human and bot share one column.** Both `<Bar>` carry `stackId="clicks"` (`stats-panel.tsx:127-128`), so the two series are welded into a single bar and cannot be compared against each other.
2. **The two colours are nearly the same colour.** `--chart-1` is `oklch(0.87 0 0)` — near-white, on a white card — and `--chart-2` is `oklch(0.556 0 0)`. Every `--chart-*` token in `app/globals.css` has chroma `0` (pure grey) and the `.dark` block repeats the light values verbatim (`globals.css:74-78` vs `109-113`), so nothing distinguishes the series and dark mode never flips.
3. **The category axis collides with itself.** Up to 20 categories are laid along a horizontal `XAxis` at `fontSize: 11`, truncated to 17 characters. For `referer`, `destination` and `slug` — long, similar-prefixed strings — the labels overlap into mush and the truncation hides the part that differs.
4. **Grouping by Day shows the wrong days.** The server returns days chronologically ascending (`apps/server/src/http/api/stats.ts:69`: `groupBy === "day" ? [asc(key)] : [desc(count), asc(key)]`), and the panel then does `stats.slice(0, MAX_BARS)` (`stats-panel.tsx:61`). For ranked dimensions that correctly takes the top 20; for `day` it takes the **oldest** 20 days and silently drops all recent traffic. There is also no date filter in the UI at all, so "All time" is the only window — even though `from`/`to` have been in `statsQuerySchema` since day one and are simply never sent.

All four are client-side. **No server change, no shared-package change, and no new dependency** — recharts 3.3.1 is already installed and supports everything below.

## Scope

- `apps/client/components/stats-panel.tsx` — rewritten (the bulk of the work).
- `apps/client/app/globals.css` — `--chart-1` / `--chart-2` given real, per-theme values.

Nothing else. `StatsPanel`'s props are unchanged, so all three call sites are untouched.

## 1. Two bars, not one stack

Drop `stackId="clicks"` from both `<Bar>`. Recharts then renders them side by side within each category, which is the direct answer to "different bars for different entities".

```tsx
<Bar dataKey="human" name="Human" fill="var(--chart-1)" radius={[2, 2, 0, 0]} />
<Bar dataKey="bot"   name="Bot"   fill="var(--chart-2)" radius={[2, 2, 0, 0]} />
```

(For the horizontal layout in step 3, the radius corners become `[0, 2, 2, 0]`.)

## 2. Give the two series real colours

In `app/globals.css`, replace the `--chart-1` / `--chart-2` lines in **both** `:root` and `.dark` — different values per theme, which is the part currently missing:

```css
:root {
  --chart-1: oklch(0.55 0.16 255);  /* human — blue */
  --chart-2: oklch(0.70 0.15 65);   /* bot — amber */
}
.dark {
  --chart-1: oklch(0.70 0.15 255);
  --chart-2: oklch(0.80 0.14 65);
}
```

Blue/amber rather than a second grey: it is the one pair that stays separable for the common red-green colour deficiencies, and keeping chroma moderate keeps it from fighting the otherwise-monochrome UI.

`--chart-3`…`--chart-5` are left as they are. Nothing renders a third series, so fixing them now would be speculative — but they carry the same light/dark bug and need the same treatment the moment one is added.

## 3. Lay categories down the side, not across the bottom

This is the structural fix for the overlap, rather than rotating ticks or truncating harder. Branch on the grouping:

- **`day`** → keep the current vertical `BarChart`. Dates are short and uniform, so a horizontal axis works. Give the tick a `MM-DD` formatter (`key.slice(5)`) and `minTickGap={24}` so recharts thins the labels out instead of stacking them.
- **every other grouping** → `<BarChart layout="vertical">` with `<XAxis type="number" />` and `<YAxis type="category" dataKey="key" width={160} />`. Each entity gets its own full-width row with its label on the left, where a long referrer or slug has room to be read. Nothing can collide with its neighbour.

Container height follows the mode instead of a fixed `h-72`:

```tsx
const horizontal = groupBy !== "day"
const height = horizontal ? Math.max(220, buckets.length * 34) : 288
```

The wrapper keeps `w-full` and moves the height to an inline `style={{ height }}`, since the row count is not a Tailwind-expressible value.

## 4. Date range, and the right end of the day series

Add a second `Picker` beside the grouping one in `CardAction`, reusing the existing `Picker` from `components/common.tsx`:

```tsx
const RANGES = [
  { value: "7",  label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "0",  label: "All time" },
]
```

Default `"30"`. It resolves to a `from` param and nothing else:

```tsx
const from = days > 0 ? new Date(Date.now() - days * 864e5).toISOString() : undefined
useGetStatsQuery({ path, params: { ...extraParams, groupBy, from } })
```

`qs()` (`lib/api.ts:79`) already drops `undefined`, so "All time" sends no `from` and the request is byte-identical to today's. The range applies to every grouping, not just day.

Then fix the truncation to respect the server's two different orderings:

```tsx
/** Ranked dimensions: the top N. Days: the most recent N — the array is ascending. */
const trimmed = groupBy === "day" ? all.slice(-MAX_DAYS) : all.slice(0, MAX_BARS)
```

with `MAX_DAYS = 90` as a ceiling for "All time"; the range picker bounds the rest.

## 5. Fill the empty days

The server only returns days that had at least one click, so a 30-day window with traffic on four days currently renders four bars with no gaps between them — the x-positions are meaningless and the chart implies four consecutive days. For `day` only, expand to one bucket per UTC day across the window, zero-filling the missing ones, before the slice in step 4:

```tsx
/**
 * One bucket per day in the window. The aggregate skips days with no clicks,
 * which would otherwise draw a gap-free axis that misreads as consecutive days.
 */
function fillDays(buckets: StatsBucket[], from: string | undefined): StatsBucket[] {
  if (buckets.length === 0) return buckets
  const byKey = new Map(buckets.map((b) => [b.key, b]))
  const start = new Date(`${from?.slice(0, 10) ?? buckets[0].key}T00:00:00Z`)
  const end = new Date(`${buckets[buckets.length - 1].key}T00:00:00Z`)
  const out: StatsBucket[] = []
  for (const d = start; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10)
    out.push(byKey.get(key) ?? { key, human: 0, bot: 0 })
  }
  return out
}
```

## 6. Say when the list is cut

The totals line already sums the **full** response while the chart draws a subset, which is right but currently unexplained. When `trimmed.length < all.length`, append to the existing totals paragraph:

> `123` human · `4` bot — showing top 20 of 412

## Deliberately not doing

- **Not adding shadcn's `ui/chart.tsx`.** It would vendor ~300 lines of `ChartContainer`/`ChartTooltipContent` to replace the ten lines of `contentStyle` and `<Legend />` that already work. Revisit if a second chart type appears.
- **Not touching `--chart-3`…`--chart-5`** (step 2) — no series uses them.
- **Not adding server-side limiting.** A high-cardinality `referer` grouping does ship its whole tail over the wire to be cut client-side. Real, but a separate concern from readability, and unmeasured.
- **Not fixing `providesTags: ["Stats"]` never being invalidated** (`lib/store/stats.ts:14`) — unrelated to the charts.

## Verification

1. `bun run typecheck` and `bun run lint`.
2. `bun run test` — `apps/server/test/stats.test.ts` covers the aggregate and must stay green; nothing server-side changed, so it should.
3. Live, against `bun run dev` + `bun run dev:admin`, in Chrome:
   - `/home/overview/` — default view is now Last 30 days grouped by Day: one bar pair per day including zero days, blue human next to amber bot, no stacking.
   - Switch grouping to **Referrer** or **Destination** — the chart flips to horizontal rows with full-length labels down the left, nothing overlapping.
   - Switch range 7d → 90d → All time and confirm the bars change and the `from` param appears/disappears on the request.
   - `/home/orphans/` — opens on **Requested slug**, so it lands in the horizontal layout; confirm long slugs are legible and the domain filter still narrows the chart.
   - `/home/links/detail/?id=…` — same panel, a single link's clicks.
   - Toggle dark mode on each and confirm both series stay distinguishable against the dark card.
