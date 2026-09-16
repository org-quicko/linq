# Connect the Admin UI to servers the user adds

## Context

Today the Admin UI can only ever talk to the one server that served it. `lib/api.ts`
builds every request against `"/api"` on its own origin, and the whole design leans
on that: in development a Next `rewrites` proxy fakes same-origin, and in production
one Hono process serves both the export at `/admin` and the API at `/api`. The
comment in `next.config.ts` says so outright — the proxy exists "which is what lets
the UI on :3001 reach the API on :3000 without CORS".

We want the landing page, when not connected to any server, to offer **Add a server**:
the user supplies a name, a URL and an API key, that record is kept in `localStorage`,
and the UI then talks to that server over the internet. Several servers can be saved
and switched between from a control at the bottom of the sidebar.

The wireframe also reorganises the shell from the current top header into a left
sidebar — Overview, Links → Short Links, Domains, then Settings, the user, and a
**Servers** box pinned at the bottom. That reorganisation is in scope, including the
two new pages it introduces.

## The blocker: the API sends no CORS headers

This is not a frontend-only feature. `apps/server/src/http/app.ts` registers no CORS
middleware at all. A cross-origin `fetch` carrying `Authorization: Bearer` is never a
simple request, so the browser first sends `OPTIONS`, which today falls through to
`app.notFound` → a 404 with no `Access-Control-Allow-Origin`. The browser then blocks
every request. Adding a remote server cannot work until the server answers preflight.

Worse, the failure is opaque: a CORS rejection surfaces as `TypeError: Failed to fetch`
with no status, indistinguishable from the server being down. The add-server form has
to say so in its error copy, because no code can tell the two apart.

## Decisions taken

- **CORS is open**, matching the reference implementation: `app.use("/api/*", cors())`,
  which is `Access-Control-Allow-Origin: *`. No configuration, works out of the box.
  Requests still require a valid Bearer key; `*` is safe here only because the app
  uses no cookies and never sets `credentials`.
- **Several servers with a switcher**, not a single connection.
- **Active server lives in `localStorage`, not the URL.** The reference puts the server
  id in the route (`/servers/:sid/…`), but `output: "export"` cannot prerender routes
  for ids created at runtime in the browser. This app already hit that exact wall and
  solved it with query params (`/links/detail/?id=…`). Threading `?server=` through
  every `next/link` and `router.push` is real churn for little gain here, so switching
  servers does a full page load instead. See *Deliberate simplifications*.

## Storage model

New `apps/admin/lib/servers.ts` — the first app-level preference store in this codebase;
there is no existing context or provider pattern to hang it on.

```ts
export type Server = {
  id: string        // crypto.randomUUID()
  name: string      // user's label, e.g. "prod"
  apiUrl: string    // origin only, no /api suffix. "" means this same origin.
  apiKey: string
}
```

Keys: `linq.servers` (a `Server[]`) and `linq.activeServerId`. `apiUrl: ""` meaning
same-origin is what keeps the bundled UI at `/admin` working with no configuration,
and avoids baking in an origin that changes when a server is reached by another
hostname.

Exports: `listServers`, `activeServer`, `setActiveServer`, `addServer`, `updateServer`,
`removeServer`, plus the two pure helpers below. Every read wraps `JSON.parse` in
try/catch and returns `[]` on a corrupt value — the reference does not, and a corrupt
entry there throws inside a `useState` initialiser and takes out the whole app.

**Migration.** An existing user has `linq.apiKey` and no server list. On first load,
convert it into one record `{ name: "This server", apiUrl: "", apiKey }`, make it
active, and delete the old key. Nobody gets logged out by this change.

## Verifying a server before saving it

Two probes, because they answer different questions — and because a form that only
pings health will happily save a server with a garbage key:

1. `GET {apiUrl}/api/health` — unauthenticated, returns `{ status, version }`. Proves
   the URL is reachable *and* that something linq-shaped is answering.
2. `GET {apiUrl}/api/v1/me` with the Bearer key — proves the key is valid, and returns
   `{ user: { name, role }, keyPrefix }` to show on success.

Nothing is written to storage until both succeed. Three distinct failures, three
messages:

| Outcome | Message |
|---|---|
| `fetch` throws (`TypeError`) | "Could not reach that server. Check the URL, and that the server allows requests from this page." |
| health answers but isn't linq-shaped | "That URL answered, but it does not look like a linq server." |
| `/v1/me` → 401 | "The server is reachable, but that API key was rejected." |

`normalizeUrl(input)`: trim, strip a trailing slash, and if there is no scheme add one —
`http://` for `localhost`/`127.0.0.1`, `https://` otherwise. A bare host is the common
typo and is plainly meant as a URL.

## API client

`apps/admin/lib/api.ts` is the only place in the entire app that builds a request URL
(line 63), so this is contained.

- Replace the build-time `API_BASE` constant with a per-call lookup:
  `const base = server?.apiUrl ? `${server.apiUrl}/api` : "/api"`.
- Take the Bearer key from the active server rather than `getKey()`.
- Keep `NEXT_PUBLIC_LINQ_API` as the same-origin default only.
- **Change the 401 handler.** Today it clears the single key and hard-navigates to
  `/admin/`. With several servers that nukes the wrong credential. Instead clear
  `linq.activeServerId` but *keep the record*, and send the user to the landing page,
  where they can re-pick it or fix its key in Settings.
- `getKey`/`setKey`/`clearKey` go away; `app-shell.tsx` and `app/page.tsx` are their
  only callers.

`lib/use-api.ts` needs no change: it keys on `path`, and switching servers reloads the
page, so every hook remounts.

## Landing page — `app/page.tsx`

The only page that renders without a connection. Three states:

1. **No servers** — the welcome from the wireframe: brand, one line of explanation, and
   the add-server form (name, URL, API key with a reveal toggle).
2. **Servers but none active** — list them, click one to connect, plus "Add another".
3. **An active server** — `router.replace("/overview/")`, as it redirects to `/links/` today.

The add-server form moves into `components/add-server-form.tsx` so Settings can reuse
it. Build it from the existing `Field` (`components/common.tsx:32`), `Input`, `Button`
and `Card` — no new primitives.

Fix while here: the current page calls `setKey` *before* validating, so a non-401
failure leaves a bad key in storage. With user-supplied URLs, network failure becomes
the common case. Validate first, store second.

## Shell — `components/app-shell.tsx`

Rewrite the header (lines 70–116) as a left sidebar. Nothing else in the app depends on
the header markup; `AppShell`'s `{ requires, children }` render-prop signature stays, so
no page changes.

```
┌───────────┐
│ linq      │
│ Overview  │  /overview/          NEW
│ Links     │  (group label)
│  Short…   │  /links/
│ Domains   │  /domains/
│ Orphans   │  /orphans/
│ Users     │  /users/   admin only
│ ───────── │
│ Settings  │  /settings/          NEW
│ ○ name·role│                     (was the header's right cluster)
│┌─────────┐│
││ prod  ⌄ ││  ServerSwitcher      NEW
│└─────────┘│
└───────────┘
```

Extend the existing `NAV` array (line 24) with an optional `children` for the Links
group; keep the `visible: (actor) => boolean` predicate and the basePath-free hrefs
exactly as they are — the comment at lines 16–23 explains why they must stay that way.

`components/server-switcher.tsx`: a `dropdown-menu` (already in `components/ui/`)
showing the active server's name, the other saved servers, and "Add a server" /
"Manage servers" linking to Settings. Selecting another server sets the active id and
does a hard navigation to `/admin/overview/`.

One thing to handle: today, when the API is unreachable, `AppShell` renders a bare
error string with no chrome (lines 57–66). Once the URL is user-supplied that is the
likely path, so this branch must still render the sidebar — otherwise a bad server
leaves the user on a blank page with no way to switch away from it.

## New pages

**`app/overview/page.tsx`** — reuses `StatsPanel` unchanged (`path="/v1/stats"`,
`title="Clicks"`), which already serves the whole instance; the orphans page uses it
the same way. Add total counters from `useApi<Page<Link>>("/v1/links?limit=1")` and the
same for domains, reading `.total` off the existing `Page<T>` envelope.

**`app/settings/page.tsx`** — server management, per the wireframe's Settings entry: the
saved servers with the active one marked, Edit (name / URL / key, re-verified on save
with the same two probes — writing an unreachable server into the list is how a UI ends
up unable to explain why nothing loads), and Remove via the existing `ConfirmButton`
(`components/common.tsx:186`). Removing forgets a connection in this browser and
destroys nothing on the server, so no typed confirmation.

## Server — `apps/server/src/http/app.ts`

```ts
import { cors } from "hono/cors"
// …
app.use("/api/*", cors())   // before /api/health and the /api/v1 mount
```

`hono/cors` ships with Hono; no new dependency. It answers preflight with 204 and, when
`allowHeaders` is unset, echoes back the requested headers, so `authorization` and
`content-type` both pass. Registration order matters: after the global `app.use("*")`
that sets `db`/`config`/`geo`, before `app.get("/api/health")`. The catch-all redirect
handler only takes `GET|HEAD`, so preflight never reaches it.

Only `/api/*` is covered. Redirects are top-level navigations, not `fetch`, and need
nothing.

## Files

**New** — `apps/admin/lib/servers.ts`, `apps/admin/components/add-server-form.tsx`,
`apps/admin/components/server-switcher.tsx`, `apps/admin/app/overview/page.tsx`,
`apps/admin/app/settings/page.tsx`, `apps/admin/test/servers.test.ts`,
`apps/server/test/cors.test.ts`.

**Modified** — `apps/admin/lib/api.ts` (base URL + key + 401), `apps/admin/app/page.tsx`
(landing), `apps/admin/components/app-shell.tsx` (sidebar), `apps/server/src/http/app.ts`
(cors), root `package.json` (test script, below).

`next.config.ts` needs no change: the dev rewrite still serves the same-origin default.

## Verification

```bash
bun run typecheck
bun run lint
bun test            # widen the root script to: bun test apps/server/test apps/admin/test
```

`normalizeUrl` and the store's add/update/remove/migrate logic are pure, so
`apps/admin/test/servers.test.ts` covers them without a DOM — the URL heuristic and the
`linq.apiKey` migration are the two pieces worth a real check. The root `test` script is
currently scoped to `apps/server/test` and must be widened or the file never runs.

`apps/server/test/cors.test.ts`, using the existing `createHarness`:
- `OPTIONS /api/v1/links` with `Origin` and `Access-Control-Request-Headers: authorization`
  → 204, `Access-Control-Allow-Origin: *`, and `authorization` echoed as allowed.
- `GET /api/health` with `Origin` → 200 with `Access-Control-Allow-Origin: *`.
- A redirect (`GET /:slug`) is unaffected.

End-to-end, with two servers to prove it is genuinely cross-origin:

```bash
bun run dev                                   # server A on :3000
LINQ_PORT=3001 DATABASE_URL=…linq_b bun run start   # server B on :3001
bun run dev:admin                             # UI on :3001/admin  (use another port if taken)
```

1. Clear `localStorage`, open `/admin/` → the add-server form, not a bare key box.
2. Add server A (`http://localhost:3000` + its key) → lands on Overview; links and
   domains load.
3. Add server B from Settings, switch to it in the sidebar switcher → the list changes
   to B's links. This is the cross-origin path; without the CORS change it fails here
   with `TypeError: Failed to fetch`.
4. Wrong key → "the API key was rejected". Unreachable URL (`http://localhost:9999`) →
   the reach/CORS message. A non-linq URL → the "does not look like a linq server" message.
5. Remove the active server → back to the landing page with B still listed.
6. Existing-user migration: set `localStorage["linq.apiKey"]` to a valid key with no
   server list, reload → connected as "This server", old key gone.
7. Revoke the key of the active server, then act → the record survives, only the active
   pointer clears, and the landing page offers it again.

Production shape, since that is the one with no proxy:

```bash
bun run build:admin && bun run start
```
Open `http://localhost:3000/admin/`, add a *remote* server, confirm it works from the
static export.

## Deliberate simplifications

- **Active server in `localStorage`, switching via a full page load.** Two tabs cannot
  view two different servers, and a URL cannot be shared server-scoped. Mark it with a
  `ponytail:` comment naming `?server=<id>` as the upgrade path — the same query-param
  trick `/links/detail/` already uses, which is the only shape a static export allows.
- **API keys sit in plaintext `localStorage`**, as they do today and in the reference.
  Worth stating in the add-server form's copy rather than hiding.
- No per-server response cache. Switching reloads, so there is nothing stale to
  invalidate — and this admin has no caching layer to begin with.
