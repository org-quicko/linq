---
name: linq-frontend
description: Add or change a UI feature in apps/client (the Next.js Client UI). Use when adding a page or route, wiring data with RTK Query, adding a component, or gating UI by role or permission.
---

# Adding or changing a Client UI feature

1. **Pages** live under `app/<route>/page.tsx` (App Router — one directory
   per route, see `docs/repo-map.md` for the current list). **Reusable
   page-building blocks** (`row-card`, `stat-card`, `page-header`,
   `empty-state`, `domain-picker`, …) live in `components/patterns/` — check
   there before writing a new one; a feature-specific component goes
   straight in `components/`.
2. **`components/ui/` primitives are shadcn-derived** — some already carry
   `cursor-pointer` (`select`, `dropdown-menu`, `command`), most don't
   (e.g. `button`). Every clickable element must show `cursor-pointer`
   regardless — check the primitive you're using and add the class
   explicitly if it's missing rather than assuming the default is right.
3. **Data fetching is one RTK Query slice per resource** under
   `lib/store/<resource>.ts`, via `apiSlice.injectEndpoints` (see
   `domains.ts` as the reference). Use the `qs()` helper from `lib/api.ts`
   for query strings, and tag with `providesTags`/`invalidatesTags` keyed by
   id plus a `LIST` tag, so a mutation invalidates exactly what changed —
   not the whole cache.
4. **`lib/api.ts`'s `api()` is the one fetch call site** — it attaches the
   active server's key and turns a 401 into disconnect-and-redirect.
   RTK Query's base query already calls through it; never call `fetch`
   directly from a component or a new store file.
5. **Gate UI with `can` from `@linq/shared`** (`can.editLink(actor)`, etc. —
   see `app/links/page.tsx`), the same rules `auth/permissions.ts` enforces
   on the server. This is cosmetic, not the real boundary: the server still
   403s if a request bypasses it, so don't skip the server-side check
   because the button is already hidden (see `linq-backend`).
6. **`lib/servers.ts` owns the saved-servers model** (list, active server,
   API key) in `localStorage` — never put "which server is active" in Redux
   state.

## Testing

`bun run test` also runs `apps/client/test/*.test.ts` — currently
lib-level unit tests only (`servers`, `qr`, `range`), no component test
harness. Follow that pattern for client-only logic; don't introduce a
component-testing setup for one component.

## Lint / format

`bun run lint` (biome check) / `bun run format` (biome check --write) cover
both apps from the repo root — run before calling a change done.
