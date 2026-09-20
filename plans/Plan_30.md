# linq — Plan 30: link summary view at /links/{id}/summary and click-to-open from list view

Follows `plans/Plan_29.md` and `plans/Plan_28.md`.

## Context

Currently:
1. Viewing a single link's statistics, settings, rules, and visit log lives at `/links/detail/?id={uuid}`. The link ID is passed as a query parameter because earlier plans (`plans/Plan_6.md`, `plans/Plan_27.md`) assumed that Next.js static export (`output: "export"`) could not support dynamic route segments without pre-rendered IDs.
2. In the links list view (`/links/`), only the link title text and `ShortLink` badge are hyperlinked. Clicking anywhere else on the row card does nothing.

The user requirements are:
1. Clicking on a link list item should open the summary view.
2. The summary view should have the clean path `/links/{id}/summary`, eliminating query parameters.

---

## Architectural & Design Decisions

### 1. The Route: `/links/{id}/summary`

Next.js App Router dynamic routes use file-system convention `app/links/[id]/summary/page.tsx`.

#### The Static Export (`output: "export"`) Constraint
In Next.js with `output: "export"`, any dynamic route segment `[id]` must define `generateStaticParams()` at build time, otherwise `next build` errors out. Because link IDs are created dynamically at runtime in Postgres, pre-rendering every runtime UUID at build time is impossible.

However, Next.js static export can pre-render a template placeholder:
```tsx
export function generateStaticParams() {
  return [{ id: "_summary" }]
}
```
This produces `out/links/_summary/summary/index.html` during build.

#### Separation into Server Wrapper and Client Component
Under Next.js App Router, `generateStaticParams()` cannot be exported from a component marked `"use client"`. Therefore:
- `apps/client/app/links/[id]/summary/page.tsx`: Server Component that exports `generateStaticParams()` and passes the `id` param down.
- `apps/client/app/links/[id]/summary/summary-client.tsx`: Client Component (`"use client"`) that consumes the link ID and renders the full summary view.

#### Extracting the Link ID without Query Parameters
In `summary-client.tsx`, the link ID is retrieved directly from the route path without touching query parameters:
```tsx
const params = useParams<{ id: string }>()
const pathname = usePathname()
const id = params?.id && params.id !== "_summary"
  ? params.id
  : (pathname.match(/\/links\/([^/]+)\/summary/)?.[1] ?? "")
```
This ensures robust resolution:
- During client-side navigation (e.g. `router.push('/links/{id}/summary/')`): Next.js router supplies `params.id = id`.
- During direct URL load or hard refresh: `pathname` pattern matching reliably extracts `{id}` even when hydrating from the static template.
- In `next dev` development mode: `params.id` is dynamically populated.

### 2. Server Support in `mountAdmin` (`apps/server/src/http/admin-static.ts`)

When linq serves the Client UI at `/home/*` (bundled mode), a browser navigation directly to `/home/links/{uuid}/summary/` (or a hard refresh) requests that path from Hono. Because `{uuid}` was not pre-rendered on disk, standard static file lookup fails.

We update `mountAdmin`:
If the requested relative path matches `/^\/links\/[^/]+\/summary\/?$/`, serve the static summary HTML template (`links/_summary/summary/index.html`) with HTTP 200 and `no-cache`:
```ts
if (/^\/links\/[^/]+\/summary\/?$/.test(relative)) {
  const template = Bun.file(join(base, "links/_summary/summary/index.html"))
  if (await template.exists()) {
    c.header("cache-control", cacheControl("links/_summary/summary/index.html"))
    return c.body(await template.bytes(), 200, { "content-type": "text/html; charset=utf-8" })
  }
}
```
The browser receives the page HTML, loads the Next.js bundle, hydrates against `window.location.pathname`, extracts `{id}`, and queries the API via RTK Query.

### 3. Click-to-Open from Link List View

In `apps/client/components/patterns/row-card.tsx`:
- Add `onClick?: (e: React.MouseEvent) => void` to `RowCard`.
- Add conditional `cursor-pointer` class when `onClick` is provided.
- Stop click propagation on the `actions` container (`onClick={(e) => e.stopPropagation()}`) so clicking dropdown menus, edit buttons, or copy buttons does not inadvertently trigger row navigation.

In `apps/client/app/links/page.tsx` (`LinkRow`):
- Pass `onClick={() => router.push(`/links/${link.id}/summary/`)}` to `RowCard`.
- Update `link.name` link and `ShortLink` link to `/links/${link.id}/summary/`.
- Now, clicking anywhere on the link list item navigates directly to the summary view.

In `apps/client/app/archives/page.tsx`:
- Update archived link click/short-link target to `/links/${link.id}/summary/`.

### 4. Backward Compatibility for `/links/detail/`

In `apps/client/app/links/detail/page.tsx`:
Convert the page into a redirect forwarder: if a query parameter `?id={id}` is provided, redirect to `/links/{id}/summary/`; otherwise redirect to `/links/`. This ensures existing bookmarks or external references continue to work seamlessly.

### 5. Analytics Graphs as Line Chart (not Bar Chart)

Currently, `apps/client/components/stats-panel.tsx` renders all analytics using Recharts `<BarChart>`.
For the primary analytics graph (`groupBy === "day"`, representing visits over time across days):
- Replace `<BarChart>` and `<Bar>` with `<LineChart>` and `<Line>` from `recharts`.
- Use smooth interpolation (`type="monotone"`), crisp strokes (`strokeWidth={2}`), distinct theme colors (`var(--chart-1)` for Human, `var(--chart-2)` for Bot), and circular data markers (`dot={{ r: 3 }}`) with larger active hover points (`activeDot={{ r: 5 }}`).
- For ranked categorical groupings (`groupBy !== "day"`, such as OS, Browser, Platform, Referrer, Destination, Slug), retain the horizontal bar chart representation because discrete unordered entities have long labels and are ranked items rather than a continuous time series.
- In `apps/client/components/app-shell.tsx`, update the navigation icon for `/analytics/` from `BarChart3` to `LineChart` from `lucide-react` for visual consistency.

---

## Files Affected

1. **`apps/client/components/patterns/row-card.tsx`**: Add `onClick` support with `cursor-pointer` and action propagation stop.
2. **`apps/client/app/links/page.tsx`**: Wire row click to `/links/${link.id}/summary/` and update name/short link hrefs.
3. **`apps/client/app/links/[id]/summary/page.tsx`**: Server component exporting `generateStaticParams()`.
4. **`apps/client/app/links/[id]/summary/summary-client.tsx`**: Client component rendering the summary view (header, stats, settings card, rules, visits).
5. **`apps/client/app/links/detail/page.tsx`**: Forwarder redirecting to `/links/${id}/summary/`.
6. **`apps/client/app/archives/page.tsx`**: Update link detail hrefs to summary path.
7. **`apps/client/components/stats-panel.tsx`**: Switch time-series analytics graph from `BarChart` to `LineChart`.
8. **`apps/client/components/app-shell.tsx`**: Update analytics navigation icon to `LineChart`.
9. **`apps/server/src/http/admin-static.ts`**: Add fallback rule for dynamic `/links/*/summary/` routes.
10. **`apps/server/test/admin-static.test.ts`**: Add unit test for `/home/links/:id/summary/` static delivery.

---

## Verification

1. **Automated Tests**:
   - `bun test apps/server/test/admin-static.test.ts`
   - `bun test`
2. **Client Build & Lint**:
   - `bun --filter @linq/client build`
   - `bun run typecheck`
   - `bun run lint`
3. **Manual Verification**:
   - Navigate to `/links/`, click anywhere on a link list row -> verifies navigation to `/links/{id}/summary/`.
   - Verify the URL bar displays `/links/{id}/summary/` with no query parameters.
   - Refresh the page on `/links/{id}/summary/` -> verifies it reloads and renders the link summary properly without 404.
   - On `/analytics/` and `/links/{id}/summary/`, verify the Visits graph is rendered as a line chart with Human and Bot series lines.

