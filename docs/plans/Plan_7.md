# Make the Admin UI deployable on its own

## Context

The Admin UI already talks to whichever server the user has selected, over CORS,
from a list kept in the browser. The *runtime* coupling to the backend is gone.
What remains is **build-time**: `next.config.ts` hardcodes `basePath: "/admin"`,
seven `window.location` navigations spell `/admin/` literally, and three places
fall back to a same-origin `/api` when a server record carries no URL of its own.

A static host serves at a domain root and has no API on its origin, so none of
those hold there. This makes the UI a first-class standalone artefact: build it,
upload `out/` anywhere, point it at any linq server.

The bundled build stays exactly as it is — self-hosters keep one process serving
the API, the redirects and the UI at `/admin`.

## Decisions taken

- **Two build targets, one codebase.** The default `build` keeps `basePath=/admin`
  for the bundled case; a new `build:standalone` builds for a domain root.
- **A server always has an absolute URL.** The "leave it empty to use the server
  hosting this page" shortcut goes away, matching the reference implementation,
  whose server record has the URL required and no origin-derived fallback
  anywhere. The principle it states is the one worth copying: *nothing depends on
  being hosted by the instance it administers.* Being served by a server grants
  the UI no implicit URL and no implicit credential — which is exactly what lets
  both builds run the same code path.
- **Any static host, no vendor config.** Plain files plus a README section.

## 1. Drop the same-origin concept

This is the substantive change; the rest is plumbing.

`apps/admin/lib/servers.ts`
- `Server.apiUrl` becomes "absolute origin, no `/api`" — document that it is never
  empty.
- `apiBase(server)` → `` `${server.apiUrl}/api` ``, no `"/api"` branch.
- `probeServer(apiUrl, …)` likewise.
- `migrateLegacyKey()` currently writes `apiUrl: ""`. It writes
  `window.location.origin` instead — which is precisely correct, because a
  pre-multi-server browser could only ever have been talking to the origin that
  served it. Resolving that once at migration time is different from keeping a
  permanent same-origin fallback.

`apps/admin/components/server-form.tsx`
- The URL becomes required: reject a blank one with the same "fill in every
  field" shape the reference uses, and change the hint from "Leave empty to use
  the server hosting this page" to an example.
- No prefilling from `window.location.origin`. The reference does not, and a
  self-hoster typing their own origin once is cheaper than a value that is
  silently wrong on a standalone deploy.

`apps/admin/lib/api.ts`
- Delete `SAME_ORIGIN_BASE` and `NEXT_PUBLIC_LINQ_API` with it. Its only job was
  the same-origin default; a standalone build has nothing for it to point at, and
  a pinned-backend build is a separate feature nobody has asked for.
- With no active server there is now no sensible URL to call, so `api()` throws
  and sends the browser to the landing page — the same treatment a 401 gets.

Three display sites render `{server.apiUrl || "This server"}` and become just the
URL: `app/page.tsx:84`, `app/settings/page.tsx:97`, `components/server-switcher.tsx:57`.

## 2. Make the base path a build input

`apps/admin/next.config.ts` reads `process.env.NEXT_PUBLIC_BASE_PATH ?? ""`, and
uses it for `basePath`. The dev `/` → `/admin/` redirect only makes sense when a
base path is set, so it becomes conditional on it.

The seven hardcoded literals all become one exported constant — the smallest diff
and the only way they stay in step with the config:

- `lib/api.ts:8` — `LANDING_PATH`
- `components/server-switcher.tsx:41,74,78`
- `app/settings/page.tsx:109,133,150`

Everything else in the app is already base-path-free: `next/link`, `router.push`
and the `NAV`/`SETTINGS` hrefs all rely on Next prefixing them and `usePathname`
stripping them back off. That is why only `window.location` calls are affected —
Next does not rewrite those. The comment at the top of `app-shell.tsx` explains
the rule and should stay.

**Also remove the dev `/api` rewrite proxy.** It exists, by its own comment, "to
fake same-origin so CORS never appears" — and nothing fetches a relative `/api`
any more. In development you now add `http://localhost:3000` as a server like any
other, which exercises the real cross-origin path instead of hiding it.

## 3. Build targets

`apps/admin/package.json`:
- `build` → `NEXT_PUBLIC_BASE_PATH=/admin next build` (bundled; what the
  Dockerfile and `bun run build:admin` already call, unchanged from outside)
- `build:standalone` → `next build && mv out out-standalone`

Both targets otherwise write to `apps/admin/out`, and a standalone export sitting
there would be served by the backend at `/admin` with every asset path wrong. The
rename keeps them apart; add `out-standalone/` to `.gitignore` (`out/` is already
there but will not match it). Verify Bun's script shell handles both the inline
env var and `mv` on Windows — it implements them as builtins, but this is the one
step worth checking early rather than at the end.

Root `package.json` gains `build:admin:standalone`, mirroring `build:admin`.

`dev` stays on `/admin` so the documented dev URL keeps working and the bundled
shape stays exercised.

**The standalone build still needs the monorepo.** `apps/admin` imports
`@linq/shared` as raw TypeScript over a workspace symlink, and its tsconfig
extends `../../tsconfig.base.json`. So CI checks out the whole repo and runs
`bun install && bun run build:admin:standalone`, publishing `apps/admin/out-standalone`.
Say so in the README; it is the thing someone wiring up a static host will get
wrong first.

## 4. The server needs no change

`mountAdmin` already degrades correctly: with no export present it 404s and the
API and redirects carry on, so a backend-only deployment works today. CORS is
already open on `/api/*` and tested. Keep both.

## 5. Docs

`README.md` has three claims this falsifies:
- "In production there is no second process: the UI is a static export that the
  server itself serves at `/admin`."
- The ports table marking the UI "(development only)".
- "build an image that serves the API, the redirects and the Admin UI from one
  process."

Rewrite those as *one* of two supported shapes, add a **Deploying the Admin UI**
section (build command, what to upload, that `trailingSlash` means a host must
serve `x/index.html` for `/x/`, and the whole-repo build requirement), and update
the dev step now that you add a server rather than relying on a proxy. The README
also still says nothing about the add-a-server flow at all — fix that while here.

`.env.example:4` calls `LINQ_PORT` the port for "redirects, REST API and the admin
UI"; the UI is now optional there.

`CONTEXT.md` gains **Server**: a linq instance the Admin UI connects to, saved in
the browser as a name, a URL and a Key. It is a real user-facing noun that the
glossary is currently missing.

**`docs/adr/0006`** — the topology decision, and with it the open-CORS decision
made in the previous milestone that never got written down. They are one decision
seen twice: the UI may live on another origin, therefore `/api/*` answers any
origin, therefore a key is the only thing standing between a caller and the API.
`Dockerfile` and `docker-compose.example.yml` currently encode "one image, one
process" as fact with no recorded reasoning. Per the ADR convention here, name no
other product.

## 6. Tests

`apps/admin/test/servers.test.ts` pins the behaviour being removed —
`apiBase(null) === "/api"`, the empty-`apiUrl` case, and the migration asserting
`apiUrl === ""`. Update them to the absolute-URL invariant, and give the
`MemoryStorage` window stub an `origin` so the migration test can assert it now
resolves to a real URL.

`apps/server/test/admin-static.test.ts` needs nothing: its `skipIf(!built)` guard
already covers the backend-only case correctly.

## Verification

```bash
bun run typecheck && bun run lint
bun run build:admin              # bundled: basePath /admin
bun run build:admin:standalone   # standalone: root
bun run test
```

Check the bundled export still carries `/admin` in its asset paths and the
standalone one does not:

```bash
grep -o '/admin/_next' apps/admin/out/index.html | head -1              # expect a hit
grep -c '/admin/_next' apps/admin/out-standalone/index.html             # expect 0
```

**Bundled, unchanged behaviour** — `bun run build:admin && bun run start`, open
`http://localhost:3000/admin/`, add that server by URL, confirm links/domains/users
load and the switcher works.

**Standalone, the real test** — serve the standalone export from a *different
origin* than the API, so nothing can accidentally resolve same-origin:

```bash
bun run dev                                         # API on :3000
bunx serve apps/admin/out-standalone -l 4000        # UI on :4000, any static server
```

Open `http://localhost:4000/` — the landing page must appear at the **root**, not
`/admin/`. Add `http://localhost:3000`, then confirm in the browser:

1. Overview, Links, Domains, Users all load, and clicking through keeps working
   (no `/admin` prefix anywhere in the URLs).
2. A hard navigation still lands correctly — switch servers, and use Forget on the
   active one, since those are the `window.location` paths that carried the
   literal `/admin/`.
3. A revoked key returns to the landing page at `/`, keeping the record.
4. The add-server form now **rejects a blank URL** instead of probing the static
   host.
5. Deep-link straight to `http://localhost:4000/settings/domains/` — this is the
   `trailingSlash` behaviour a static host has to honour.

Finally, confirm the backend alone is still sound: delete `apps/admin/out`, start
the server, and check `/api/health` answers while `/admin/` 404s.
