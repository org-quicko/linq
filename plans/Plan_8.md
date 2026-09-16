# linq — Plan 8: rename apps/admin → apps/client, RTK Query feature slices, skeleton/linear loading

Follows `plans/Plan_7.md`.

## Context

Three follow-up requests on the admin UI:

1. **Directory naming.** The app directory is still `apps/admin`, but `docs/adr/0006-the-admin-ui-is-a-client-not-a-page.md` already frames this UI as "a client, not a page" — a standalone client that can be pointed at any linq server. The directory name should match that framing. This is a **path-only** rename: `@linq/admin` (the npm package name), the `dev:admin`/`build:admin`/`build:admin:standalone` npm scripts, the `admin` role, and "Admin UI" as product naming all stay — the same scoping already used when the URL space was renamed from `/admin` to `/home`.

2. **State management.** Every page fetches through a hand-rolled `useApi<T>(path)` hook (`apps/admin/lib/use-api.ts:23`) with independent per-page state and manual `.reload()` calls after writes. This has a real cross-page staleness bug: editing a domain on `/domains` does not refresh the domain count on `/overview` or `/orphans`, because each page's `useApi` call has no knowledge of any other page's. The ask is proper Redux, organized as feature slices rather than one big reducer.

3. **Loading UX.** Every loading state renders the same plain "Loading…" text (`apps/admin/components/common.tsx`, the `QueryState` component) whether it's a page's first paint (no data at all) or a background refetch after a save (data already on screen). The ask: skeleton placeholders when there's genuinely nothing to show yet, and a non-blocking linear progress indicator over the existing data when it's only being refreshed.

Decisions already made (confirmed with the user before writing this plan):
- **RTK Query**, not classic slices + `createAsyncThunk` — one base `createApi` with per-feature `injectEndpoints` files. This also fixes item 2's staleness bug for free via tag-based cache invalidation, and its `isLoading`/`isFetching` flags map directly onto item 3 with no hand-rolled "keep stale data during refetch" logic.
- `apps/admin/lib/servers.ts` (the multi-server connection/API-key state) stays exactly as-is — out of scope, not part of the data-fetching layer being replaced.

No state library is installed anywhere in the repo today (confirmed by grep across `apps/` and `packages/` for `redux|zustand|jotai|recoil|createSlice|configureStore|react-redux` — zero matches), so `@reduxjs/toolkit` and `react-redux` are new dependencies.

## 1. Rename `apps/admin` → `apps/client`

```bash
git mv apps/admin apps/client
rm -rf apps/admin   # gitignored build/node_modules leftovers git mv won't move
bun install         # relink the workspace package at its new path
```

A full-repo grep for the literal string `apps/admin` (excluding `node_modules`/`.next`/`out`/`out-standalone`/`dist`/`.git`) turned up exactly these live references to update, and nothing in any `tsconfig*.json`, `docker-compose.example.yml`, or `.github/workflows` (the last doesn't exist):

- **`package.json:15`** (root) — `"test": "bun test apps/server/test && bun test apps/admin/test"` → `apps/client/test`. Leave `dev:admin`, `build:admin`, `build:admin:standalone` alone — they filter by package name (`bun --filter @linq/admin`), not path.
- **`Dockerfile:4,10,15,34,44`** — the stage-1 comment, both `COPY apps/admin/package.json apps/admin/` lines, `COPY apps/admin apps/admin`, and `COPY --from=build /app/apps/admin/out apps/admin/out` all become `apps/client`. The `--filter '@linq/admin'` build commands stay as-is.
- **`biome.json:12`** — `"!apps/admin/components/ui"` → `"!apps/client/components/ui"`.
- **`apps/server/src/http/admin-static.ts:11-12`** — only the path literal inside `adminRoot`'s `resolve(...)` changes: `"../../../admin/out"` → `"../../../client/out"`. The constant name `adminRoot`, the function `mountAdmin`, and the file name itself stay unchanged.
- **`README.md:168,173,177,186`** — four prose mentions of `apps/admin/out`, `apps/admin/out-standalone`, and "not from `apps/admin` alone" → `apps/client` equivalents.

**Left untouched:** `plans/Plan_1.md`…`Plan_7.md` (frozen historical records — same reasoning as not editing `docs/adr/0006`) and `docs/adr/0006` itself.

## 2. Redux Toolkit + RTK Query, as feature slices

### Layout

Follows the existing flat `lib/` convention (`apps/admin/lib/{api,servers,base-path,use-api}.ts`) rather than a new top-level `features/` folder:

```
apps/client/lib/store/
  index.ts   # configureStore, RootState/AppDispatch types, typed hooks
  api.ts     # base createApi: reducerPath, baseQuery adapter, tagTypes
  links.ts   # injectEndpoints — links feature
  domains.ts # injectEndpoints — domains feature
  users.ts   # injectEndpoints — users + api keys feature
  stats.ts   # injectEndpoints — stats + tags
apps/client/components/providers.tsx  # new client-boundary wrapper for <Provider>
```

`apps/admin/lib/api.ts` (the `api()` fetch wrapper, `ApiError`, `qs()`) is reused as-is inside the new `baseQuery`, not reimplemented; `apps/admin/lib/servers.ts` stays untouched and is imported by `api.ts` exactly as today.

Add to `apps/client/package.json` `dependencies`: `@reduxjs/toolkit`, `react-redux`.

### Base API slice (`lib/store/api.ts`)

```ts
import { createApi } from "@reduxjs/toolkit/query/react"
import type { BaseQueryFn } from "@reduxjs/toolkit/query/react"
import { ApiError, api } from "../api"

const baseQuery: BaseQueryFn<
  { path: string; method?: string; body?: unknown },
  unknown,
  { status: number; code: string; message: string }
> = async ({ path, method, body }) => {
  try {
    const data = await api(path, {
      method,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    return { data }
  } catch (err) {
    if (err instanceof ApiError) return { error: { status: err.status, code: err.code, message: err.message } }
    return { error: { status: 0, code: "unknown", message: (err as Error).message } }
  }
}

export const apiSlice = createApi({
  reducerPath: "api",
  baseQuery,
  tagTypes: ["Link", "Domain", "User", "Key", "Stats"],
  endpoints: () => ({}),
})
```

Wrapping the existing `api()` (`apps/admin/lib/api.ts:25`) this way preserves its 401-disconnect-and-redirect behavior verbatim.

### Representative feature (`lib/store/links.ts`)

Modeled on the 4 endpoints `apps/admin/app/links/page.tsx`, `links/trash/page.tsx`, `links/overview/page.tsx` and `links/detail/page.tsx` currently call ad hoc via `useApi("/v1/links...")` plus inline `post`/`patch`/`del` writes:

```ts
import type { Click, Link, Page, Rule } from "@linq/shared"
import { qs } from "../api"
import { apiSlice } from "./api"

type LinkFilters = {
  domainId?: string
  status?: "active" | "archived" | "all"
  sort?: "createdAt" | "clicks"
  search?: string
  tags?: string
  limit?: number
  offset?: number
}

export const linksApi = apiSlice.injectEndpoints({
  endpoints: (build) => ({
    listLinks: build.query<Page<Link>, LinkFilters>({
      query: (filters) => ({ path: `/v1/links${qs(filters)}` }),
      providesTags: (result) =>
        result
          ? [...result.data.map((l) => ({ type: "Link" as const, id: l.id })), { type: "Link" as const, id: "LIST" }]
          : [{ type: "Link" as const, id: "LIST" }],
    }),
    getLink: build.query<Link, string>({
      query: (id) => ({ path: `/v1/links/${id}` }),
      providesTags: (_r, _e, id) => [{ type: "Link", id }],
    }),
    getLinkRules: build.query<Rule[], string>({
      query: (linkId) => ({ path: `/v1/links/${linkId}/rules` }),
      providesTags: (_r, _e, linkId) => [{ type: "Link", id: `${linkId}-rules` }],
    }),
    getLinkClicks: build.query<Page<Click>, { linkId: string; bot: "any" | "true" | "false" }>({
      query: ({ linkId, bot }) => ({ path: `/v1/links/${linkId}/clicks${qs({ bot, limit: 25 })}` }),
      providesTags: (_r, _e, { linkId }) => [{ type: "Link", id: `${linkId}-clicks` }],
    }),
    createLink: build.mutation<Link, Partial<Link>>({
      query: (body) => ({ path: "/v1/links", method: "POST", body }),
      invalidatesTags: [{ type: "Link", id: "LIST" }],
    }),
    updateLink: build.mutation<Link, { id: string; body: Partial<Link> }>({
      query: ({ id, body }) => ({ path: `/v1/links/${id}`, method: "PATCH", body }),
      invalidatesTags: (_r, _e, { id }) => [{ type: "Link", id }, { type: "Link", id: "LIST" }],
    }),
    archiveLink: build.mutation<void, string>({
      query: (id) => ({ path: `/v1/links/${id}`, method: "DELETE" }),
      invalidatesTags: (_r, _e, id) => [{ type: "Link", id }, { type: "Link", id: "LIST" }],
    }),
    restoreLink: build.mutation<Link, string>({
      query: (id) => ({ path: `/v1/links/${id}`, method: "PATCH", body: { status: "active" } }),
      invalidatesTags: (_r, _e, id) => [{ type: "Link", id }, { type: "Link", id: "LIST" }],
    }),
    purgeLink: build.mutation<void, string>({
      query: (id) => ({ path: `/v1/links/${id}/purge`, method: "DELETE" }),
      invalidatesTags: (_r, _e, id) => [{ type: "Link", id }, { type: "Link", id: "LIST" }],
    }),
  }),
})

export const {
  useListLinksQuery, useGetLinkQuery, useGetLinkRulesQuery, useGetLinkClicksQuery,
  useCreateLinkMutation, useUpdateLinkMutation, useArchiveLinkMutation,
  useRestoreLinkMutation, usePurgeLinkMutation,
} = linksApi
```

Ownership transfer is `updateLink` with `ownerId` in the body — no separate endpoint.

`{ type: "Link", id: "LIST" }` is provided by every `listLinks` call regardless of its filter args (overview's `?limit=1`, the filtered links list, trash's `?status=archived`), so any mutation touching the list tag refetches all of them in the background — this is what fixes the item-2 staleness bug.

**`domains.ts`, `users.ts`, `stats.ts` follow the identical shape**: one list query + per-id detail queries with list-tag/id-tag `providesTags`, one mutation per existing write endpoint with the same two-tag `invalidatesTags`. `users.ts` also owns the keys sub-resource used by `apps/admin/app/settings/users/page.tsx`'s `KeysPanel` (`listKeys(userId)`, `mintKey`, `revokeKey`, tag `{type:"Key", id: userId}`). `stats.ts` covers `/v1/stats` (parametrized by `orphan`/`groupBy`) and `/v1/tags`, with no mutations.

Four components call `useApi`/`lib/api.ts` directly today and migrate alongside the feature file that matches them: `app-shell.tsx` (`/v1/me` → fold into `users.ts`), `stats-panel.tsx` and `tag-picker.tsx` (→ `stats.ts`), `rules-editor.tsx` (link rules PUT → `links.ts`).

### Store + Provider

```ts
// apps/client/lib/store/index.ts
import { configureStore } from "@reduxjs/toolkit"
import { useDispatch, useSelector, type TypedUseSelectorHook } from "react-redux"
import { apiSlice } from "./api"

export const store = configureStore({
  reducer: { [apiSlice.reducerPath]: apiSlice.reducer },
  middleware: (getDefault) => getDefault().concat(apiSlice.middleware),
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
export const useAppDispatch: () => AppDispatch = useDispatch
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector
```

`apps/admin/app/layout.tsx:1-20` has no `"use client"` and exports `metadata`, which a client component can't do — so the store is wired in via a wrapper instead of converting the layout itself:

```tsx
// apps/client/components/providers.tsx
"use client"
import type { ReactNode } from "react"
import { Provider } from "react-redux"
import { store } from "@/lib/store"

export function Providers({ children }: { children: ReactNode }) {
  return <Provider store={store}>{children}</Provider>
}
```

`layout.tsx:14` (`{children}`) becomes `<Providers>{children}</Providers>`; `Toaster` stays a sibling outside it, unchanged.

### Migrating the pages — one mechanical pattern, applied everywhere

- `const x = useApi<T>(path)` → `const { data, isLoading, isFetching, error } = useXQuery(args)`; `rows = data?.data ?? []` is unchanged.
- Inline `post/patch/put/del` calls → the matching mutation hook, invoked as `await mutate(args).unwrap()` (`.unwrap()` keeps the existing `try {...} catch { toast.error(...) }` pattern working, since RTK mutation promises don't reject by default).
- `.reload()` calls disappear — `invalidatesTags` refetches every affected query, including ones on other pages.
- `error` changes shape from `string | null` to `{status, code, message} | undefined` — every `err.message`-style read becomes `error?.message` (absorbed by the new `QueryState`, see §3).

Applies identically to all 9 route files under `apps/admin/app/` that call `useApi` today (`overview`, `orphans`, `links`, `links/new`, `links/overview`, `links/trash`, `links/detail`, `domains`, `domains/trash`, `domains/overview`, `settings/users` — 21 call sites total) — see the `settings/users/page.tsx` before/after in §3 as the concrete template.

### Dead code removed at the end

- `useApi` in `apps/admin/lib/use-api.ts:23` — deleted. `useDebounced` (`use-api.ts:57`) is unrelated (generic input-debounce for search boxes) and stays.
- `post`/`patch`/`put`/`del` in `apps/admin/lib/api.ts` — deleted only after re-grepping the whole app for direct calls once every page and the four components above have migrated (`api()`, `ApiError`, `qs()` stay — the new `baseQuery` and every `query()` builder still use them).

## 3. Skeleton + linear-progress loading UX

### `components/common.tsx` changes

Add `TableSkeleton({rows, cols})` and `CardSkeleton()`, both built on the existing, currently-unused `apps/admin/components/ui/skeleton.tsx`, and rework `QueryState` (currently `apps/admin/components/common.tsx`, the `{loading, error, empty, emptyMessage}` component) to take RTK Query's flags directly:

```tsx
export function TableSkeleton({ rows = 5, cols }: { rows?: number; cols: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <TableRow key={r}>
          {Array.from({ length: cols }).map((_, c) => (
            <TableCell key={c}><Skeleton className="h-4 w-full" /></TableCell>
          ))}
        </TableRow>
      ))}
    </>
  )
}

export function CardSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-7 w-16" />
    </div>
  )
}

/** Skeleton when there's no data yet; a thin bar over existing data during a
 *  background refetch; otherwise error / empty / nothing (render real rows). */
export function QueryState({
  isLoading, isFetching, error, empty, skeleton, emptyMessage = "Nothing here yet.",
}: {
  isLoading: boolean
  isFetching?: boolean
  error?: { message: string } | null
  empty?: boolean
  skeleton?: ReactNode
  emptyMessage?: string
}) {
  return (
    <>
      {isFetching && !isLoading ? <LinearProgress /> : null}
      {isLoading ? (skeleton ?? <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>) : null}
      {!isLoading && error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error.message}</p>
      ) : null}
      {!isLoading && !error && empty ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{emptyMessage}</p>
      ) : null}
    </>
  )
}

function LinearProgress() {
  return (
    <div className="relative mb-2 h-0.5 w-full overflow-hidden rounded-full bg-muted" role="status" aria-label="Refreshing">
      <div className="absolute inset-y-0 w-1/3 animate-[linear-progress_1.1s_ease-in-out_infinite] rounded-full bg-primary" />
    </div>
  )
}
```

One keyframe added to `apps/admin/app/globals.css`:

```css
@keyframes linear-progress {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(400%); }
}
```

Hand-rolled rather than a new dependency — Tailwind v4's arbitrary-animation syntax picks it up directly; `tw-animate-css` (already a dependency) is for pre-built named animations, not a place to register a custom one.

### `settings/users/page.tsx` — before / after

Before (`apps/admin/app/settings/users/page.tsx:57,62-69,82`):
```tsx
const users = useApi<Page<User>>("/v1/users?limit=200")
async function run(action: () => Promise<unknown>) {
  try { await action(); users.reload() }
  catch (err) { toast.error(err instanceof Error ? err.message : "That did not work.") }
}
...
<QueryState loading={users.loading} error={users.error} empty={rows.length === 0} />
```

After:
```tsx
const { data, isLoading, isFetching, error } = useListUsersQuery({ limit: 200 })
const rows = data?.data ?? []
const [updateUser] = useUpdateUserMutation()
async function run(id: string, body: Parameters<typeof updateUser>[0]["body"]) {
  try { await updateUser({ id, body }).unwrap() }
  catch (err) { toast.error(err instanceof Error ? err.message : "That did not work.") }
}
...
<QueryState
  isLoading={isLoading} isFetching={isFetching} error={error}
  empty={rows.length === 0} skeleton={<TableSkeleton rows={5} cols={6} />}
/>
```

Same shape for `KeysPanel` (`apps/admin/app/settings/users/page.tsx:219-232`: `useListKeysQuery`/`useMintKeyMutation`/`useRevokeKeyMutation`, `TableSkeleton cols={5}`) and `AddUserDialog.create()` (`apps/admin/app/settings/users/page.tsx:328-343`: two mutation calls in sequence, same try/catch). Overview's stat tiles use `CardSkeleton` per tile instead of `TableSkeleton` since they aren't inside a `DataTable`.

## Sequencing

1. **Rename** (§1) — mechanical, zero logic risk, do first so every later diff is written against the final path.
2. **Store scaffold** — `lib/store/api.ts`, `index.ts`, `providers.tsx`, `layout.tsx` wiring, the two new dependencies. Verify it boots with no endpoints yet.
3. **`common.tsx` loading-UX rework** — land `TableSkeleton`/`CardSkeleton`/the new `QueryState` shape and the keyframe *before* migrating any page, so each page's diff only swaps its hook and its `QueryState` props once.
4. **Migrate pages one feature file at a time**: `links.ts` + its 5 pages, then `domains.ts` + its 3 pages, then `users.ts` + `settings/users`, then `stats.ts` + `overview`/`app-shell`/`stats-panel`/`tag-picker`/`rules-editor`.
5. **Delete dead code** — `useApi`, and `post`/`patch`/`put`/`del` once the grep check confirms nothing else calls them.

## Verification

- `bun run typecheck` — catches stale `apps/admin` import paths, removed `useApi` call sites, RTK Query generic mismatches.
- `bun run lint` (Biome) — also confirms the renamed `!apps/client/components/ui` exclude glob actually excludes shadcn output.
- `bun run build:admin` once, then `bun run test` — un-skips `apps/server/test/admin-static.test.ts` (its `built` gate checks `existsSync(join(adminRoot, "index.html"))`, so it silently skips until the export exists at the renamed `adminRoot`) and runs the full `apps/server/test` + `apps/client/test` suites.
- Live check via Chrome browser automation against `bun run dev` + `bun run dev:admin`: (a) a list page's first load shows the table skeleton, not "Loading…"; (b) editing a row shows the thin bar sweep across the still-visible existing rows with no skeleton flash, then the row updates in place; (c) edit a domain on `/domains`, navigate to `/overview`, confirm the domain count is fresh without a manual page reload — the concrete proof the item-2 staleness bug is fixed; (d) check `read_console_messages` for Redux/Provider warnings.

## Risks

- **RTK Query's default cache lifetime** (`keepUnusedDataFor`, 60s) means navigating away and back within a minute serves cached data with no refetch at all, which is a behavior change from today's every-mount `useApi` fetch. Acceptable for a low-traffic internal admin tool; call out if the user wants a shorter/zero cache window on any specific list.
- **`layout.tsx` currently has no client boundary**; introducing `<Providers>` is the first client-side wrapper at the root. If any other server-only concern gets added to `layout.tsx` later, it has to go outside `<Providers>` or above it, not inside — worth a one-line comment in the file when this lands.
- **Deleting `post`/`patch`/`put`/`del` from `lib/api.ts`** is only safe after every direct caller (not just the 9 pages) is confirmed migrated — `rules-editor.tsx`, `tag-picker.tsx`, `stats-panel.tsx`, `app-shell.tsx` all need the same re-grep pass before that deletion, not just after the page migrations.
