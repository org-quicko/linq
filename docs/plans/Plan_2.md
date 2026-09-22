# link — Plan 2: tag filtering, logging, shadcn/ui, permission-aware controls

Follows `docs/plans/Plan_1.md`, whose milestones 1–7 are complete.

> Work that follows this plan continues in [`Plan_3.md`](./Plan_3.md): keyless
> geolocation and an admin purge.

> **Status: implemented.** All four items and defects D1–D4 are done; 192 server
> tests pass, `tsc -b` and `biome check` are clean, and the Admin UI exports all
> seven pages. Where the build differed from the plan below:
>
> - **pino-roll works under Bun**, so the fallback in §2 was never needed. The
>   spike is now the rotation test in `apps/server/test/log.test.ts`.
> - **Async storage survives the driver** (`test/log.test.ts`, "survives an await
>   on the database driver"), so `c.var.log` was never needed either.
> - **The unhandled-error line stays in `app.onError`.** Hono invokes it from
>   inside the composed handler chain, so the request scope — and the request id
>   — is still open there. There is a test pinning that.
> - **`matchRules` got one debug line instead of a span**, for the reason
>   `geo.lookup` did: it is synchronous and on the redirect path, and a span
>   would put a microtask there for nothing.
> - **The shadcn CLI has changed.** `init --base-color` is gone; the run was
>   `init --base radix --no-monorepo -p nova`. It writes `style: "radix-nova"`,
>   uses `cn` and `radix-ui` rather than clsx/tailwind-merge and `@radix-ui/*`,
>   and wires up `next/font/google`. The webfont was removed again: the export is
>   built inside the image, and a Google font would make the build need network
>   access to render text. `--font-sans` is a system stack in `globals.css`.
> - **`components/ui.tsx` unpacked into `components/common.tsx`**, not one file
>   per export: `Field`, `QueryState`, `CopyButton` and `When` are four small
>   things with the same consumers. It also holds `DataTable` (the header row,
>   identical in all five tables), `Picker` (the four-part shadcn `Select`, which
>   ten call sites would otherwise repeat) and `ConfirmButton`.
> - **Biome needed two config changes**, both in `biome.json`: the vendored
>   `apps/admin/components/ui/**` is excluded, as the plan anticipated, and
>   `css.parser.tailwindDirectives` is on, because `globals.css` is no longer one
>   line.
>
> Not verified here, for want of a Postgres and a browser on this machine: the
> compose-level log inspection and the four-role Admin UI walkthrough, both in
> Verification below. An equivalent of the first was run against PGlite, writing
> a real rotating file: every value in the "must print nothing" list was absent.

## Context

The API, redirect handler, rules, stats and a working Admin UI all ship, and 162
tests pass. Four gaps remain before Plan 1's milestone 8 (ship):

1. **Tag filtering** works on the server but is barely usable in the UI — a
   free-text comma box that nobody can discover tags from.
2. **There is no logging.** Seven scattered `console.*` calls are the entire
   observability story. An operator running this self-hosted cannot see what
   happened on a request, and nothing is persisted.
3. **The UI component layer is hand-rolled.** `components/ui.tsx` was written to
   keep the dependency count down; Plan 1 always specified shadcn/ui, and the
   growing UI (dialogs, toasts, the combobox the tag picker needs) is where
   hand-rolling stops paying.
4. **Role gating in the UI is inconsistent.** Some controls check role, some
   check ownership, some check neither — so users are shown buttons the server
   then refuses with a 403, and two pages have no gate at all.

Outcome: a discoverable tag filter, structured rotating file logs that never
leak secrets and never reverse the project's privacy posture, canonical
shadcn/ui components, and one shared permission module the server and UI both
read from so they cannot drift.

---

## Defects found while auditing

Four existing bugs turned up during this audit. None was part of the original
request; all are fixed as part of the work below rather than left for later.

### D1 — Owner select is enabled for users the server forbids, then traps itself

`apps/admin/app/links/detail/page.tsx:197`

```ts
disabled={!canEdit || (!canTransferToAnyone && link.ownerId !== ownerId)}
```

`ownerId` is local draft state seeded from `link.ownerId` (`:111`), so this
compares the link's owner against **the currently selected dropdown value**, not
against the signed-in user. Two consequences:

1. On first render the two are equal, so the clause is `false` and the select is
   **enabled for any non-admin with `canEdit`** — including an editor editing
   someone else's link, whom the server refuses at
   `apps/server/src/http/api/links.ts:195-197`.
2. The moment a non-admin picks a different user, the clause flips to `true` and
   the select **disables itself**, trapping the draft value with no way to revert
   short of a reload. `save()` (`:127`) then ships the `ownerId` and takes a 403.

The comparison the hint at `:189-193` implies is `link.ownerId !== userId` — but
`userId` is never passed into `SettingsCard`, whose props (`:100-105`) are only
`link`, `canEdit`, `canTransferToAnyone`, `onSaved`.

**Severity:** user-visible; silently produces a 403 on a legitimate-looking
action, and strands unsaved edits.
**Fixed in:** §4, via `can.transferLink(me, link)` plus threading `userId` into
`SettingsCard`. Covered by the role walkthrough in Verification.

### D2 — The MaxMind licence key can be written to the logs

`apps/server/src/clicks/geo.ts:40`

```ts
console.error(`geo: ${EDITION} unavailable, clicks will have no location:`, err)
```

`err` originates from the `fetch` at `:76`, whose URL is built at `:72-74` with
`license_key=${encodeURIComponent(licenseKey)}` embedded in it. A network-layer
failure (DNS, TLS, connection refused) commonly carries the requested URL in its
message, so the secret reaches the output stream in full.

This is latent today — `console.error` goes to stdout — but becomes materially
worse the moment logging writes to a **retained, rotating file on a mounted
volume**, which is exactly what item 2 introduces. The same shape applies to
`apps/server/src/clicks/record.ts:17`, where `bun:sql`/drizzle put the full
`DATABASE_URL` including its password inside connection-failure messages.

Neither is reachable by pino's `redact`, which matches field paths — here the
secret is a *substring of a message string*, not a field.

**Severity:** credential disclosure to disk.
**Fixed in:** §2, redaction layer 3 (stream-level scrub of known boot-time
secrets, applied to each serialised line before `write`). Two regression tests
assert a `license_key=…` and a DSN-with-password in an `err.message` are both
scrubbed.

### D3 — `Button` silently overrides a caller's `type`

`apps/admin/components/ui.tsx:25` — `type="button"` is set **before** the props
spread, so `<Button type="submit">` is ignored. The login and create-link forms
submit only because their handlers are also wired to `onSubmit`.
**Fixed in:** §3, during the shadcn port.

### D4 — Missing React key

`apps/admin/app/users/page.tsx:70` — the `<>` fragment inside `rows.map` carries
no `key`; it sits on the inner `<tr>` instead, so React warns on every render of
the users table.
**Fixed in:** §3, becomes a keyed `<Fragment>`.

---

## 1. Tag filtering

**Already works server-side.** No API change:

- `packages/shared/src/links.ts:35-45` — `tags` is a comma-separated string,
  transformed to a lowercased `string[]`.
- `apps/server/src/http/api/links.ts:135` — `arrayOverlaps(links.tags, q.tags)`,
  Postgres `&&`, matching a link carrying **any** of the tags.
- `apps/server/src/db/schema.ts:90` — `links_tags_idx` GIN index backs it.
- `GET /api/v1/tags` (`http/api/links.ts:226-241`) returns `[{tag, count}]` over
  active links, busiest first. Nothing in the admin consumes it today.

Semantics stay **ANY**, matching Plan 1.

**UI changes only.**

- New `apps/admin/components/tag-filter.tsx` — a shadcn Popover + Command
  multi-select fed by `useApi<{tag,count}[]>("/v1/tags")`, showing each tag with
  its count, plus removable chips for the selection.
- `apps/admin/app/links/page.tsx:77-81` — replaces the free-text `Input`. The
  page already serialises `filters.tags` through `qs()`, so the wire format is
  unchanged (`?tags=a,b`); the component just produces that string.
- Reused for **tag entry** on `app/links/new/page.tsx` and the settings card in
  `app/links/detail/page.tsx` (both comma-split free text today), in a
  `creatable` mode allowing a tag not yet in the list.
- **Debounce:** the list refetches on every keystroke of the search box
  (`app/links/page.tsx:45-48`). Add 300 ms.

**Tests:** server behaviour is already covered in `test/links.test.ts`. No new
server tests; UI verification is manual.

---

## 2. Logging

Seven `console.*` calls are all that exists — no library, no request log, no
file output.

### Shape

- **pino + pino-roll**, pino writing **in-process** to pino-roll's SonicBoom
  stream via `pino(opts, stream)` — **not** `pino.transport()`. Transports rely
  on `worker_threads` + `thread-stream`, the least proven part of pino under
  Bun, and a broken transport loses logs silently. SonicBoom is already async
  and buffered, and gives a real `flush()` for shutdown and tests.
- Writes to `${LINQ_DATA_DIR}/logs/linq.log` **and** stdout (`pino.multistream`).
  Stdout matters: `docker-compose.example.yml` tells operators to read the
  bootstrap admin key from `docker compose logs`.
- **info** = start/end of every request and instrumented service function.
  **debug** = parameters and an explicit projection of results.
- Disk is capped at `MAX_SIZE × RETAIN` (100 MB default). This is not cosmetic:
  `LINQ_DATA_DIR` is the same mounted volume holding the GeoLite2 mmdb, so an
  unbounded log breaks the geo refresh.

### New config

| Key | Default | Purpose |
|---|---|---|
| `LINQ_LOG_LEVEL` | `info` | `trace\|debug\|info\|warn\|error\|fatal\|silent` |
| `LINQ_LOG_FILE` | `${LINQ_DATA_DIR}/logs/linq.log` | `""` disables the file, stdout only |
| `LINQ_LOG_MAX_SIZE` | `20m` | pino-roll size trigger |
| `LINQ_LOG_RETAIN` | `5` | rotated files kept |

Added to `config.ts`, `.env.example`, `Dockerfile`,
`docker-compose.example.yml`, `.gitignore` (`*.log`), and **`apps/server/test/helpers/db.ts`** —
its `testConfig` is an explicit `Config` literal, so omitting them breaks the
build. Tests use `LINQ_LOG_LEVEL: "silent"`.

### Files

| Path | Responsibility |
|---|---|
| `apps/server/src/log.ts` (new, ~110 lines) | pino instance, `initLogger`, ALS request context, `span`, `reqLog`, `flushLogs`, `withRequestLog` middleware, redaction |
| `apps/server/src/http/client-ip.ts` (new) | `clientIp(c)` moved out of `redirect.ts` so both it and the logger can use it without a cycle |
| `apps/server/test/log.test.ts` (new) | the suite below |
| `docs/adr/0003-logs-never-persist-client-ips.md` (new) | §ADR |

Modified: `config.ts`, `main.ts`, `http/app.ts`, `http/redirect.ts`,
`clicks/geo.ts`, `clicks/record.ts`, `bootstrap.ts`, `rules/store.ts`,
`http/api/{users,links}.ts`, `apps/server/package.json`.

One file, not a `log/` directory — ~110 lines split four ways buys nothing.

### API

```ts
export let log: Logger                    // silent until initLogger runs
export async function initLogger(config: Config, destination?: Sink): Promise<void>
export async function flushLogs(): Promise<void>
export function reqLog(): Logger          // request child (carries reqId), or base logger
export function span<T>(
  name: string,
  fn: () => Promise<T>,
  io?: { in?: object; out?: (value: T) => object; level?: "info" | "debug" },
): Promise<T>
export async function withRequestLog(c: Context<Env>, next: Next): Promise<void>
```

`span` emits `start`, then `end` with `ms` and `ok`. On failure it logs
`ok: false` and **rethrows without serialising the error** — otherwise one
failed POST logs the same drizzle error at four nesting levels. `app.onError`
logs it once, with the request id.

### Correlation: AsyncLocalStorage

Service functions take `(db, …)`, not the Hono context: `listRules(db, linkId)`
is called from both `redirect.ts` and `http/api/rules.ts`, and `bootstrap()`
runs with no request at all.

- **Rejected** — threading a logger parameter: changes ~12 signatures and forces
  an `?: Logger` default on every function that must also work outside HTTP.
- **Rejected** — `c.var.log` only: most service functions never receive `c`.
- **Chosen** — `node:async_hooks` `AsyncLocalStorage` holding a pino **child**
  logger (`log.child({ reqId })`), so `reqId` lands on every line without a call
  site mentioning it. One `als.run()` per request in the existing global
  middleware; non-HTTP callers transparently get the base logger.

Unverified on this Bun version — **test 5 below exists to prove propagation
survives `await db.select()`**, the likeliest place to lose context. If it
fails, fall back to `c.var.log` for handlers plus the base logger for services,
losing correlation inside service functions.

**Request id** — `x-request-id` if inbound and matching `/^[\w-]{1,64}$/`, else
`Bun.randomUUIDv7()`. The regex is a trust boundary, not cosmetics: an
unvalidated header lets a caller inject newlines into a JSON log file (forging
entries) or 100 KB of junk per request into the disk budget. Echoed back on the
response.

### Wiring — one line in `http/app.ts`

```ts
app.use("*", async (c, next) => {
  c.set("db", db); c.set("config", config); c.set("geo", geo)
  await withRequestLog(c, next)          // was: await next()
})
```

The only global hook seeing both `/api/*` and redirect traffic, so it cannot be
ordered wrong. Fields are a fixed list:

```
info  "request"  { reqId, method, route: c.req.routePath, path }
info  "response" { reqId, method, route, path, status, ms }
debug            { params: c.req.param(), query: [...keys] }
```

`path` is the **pathname only** — a link forwards arbitrary customer query
strings, and a log file is a different disclosure surface from the
`clicks.query` column. Query **keys** at debug, never values. No request body,
no response body, ever (see below). `/admin/_next/*` sets the context but logs
nothing: one page load is ~30 immutable chunk requests, none diagnostic.

### What gets instrumented

All 21 route handlers via the middleware — **not** individually wrapped, which
would be 21 copy-pasted blocks producing what the middleware already emits.
Handlers add only what the middleware cannot know (see the `key.created`
example below).

**~12 service functions** get a `span`: `bootstrap`/`bootstrapAdmin`/
`seedDefaultDomain`, `runMigrations`, `startGeo`/`downloadMmdb`,
`recordClick`'s inner insert, `findActiveDomain`/`findActiveLink`, `listRules`,
`matchRules`, `loadLink`/`fetchLink`/`insertLink` (the slug retry loop logs
`attempts`), `fetchDomain`/`assertNoActiveLinks`, `aggregateClicks`.

**Deliberately not instrumented:**

- Pure one-liners: `detectBot`, `detectPlatform`, `mergeQuery`, `queryMap`,
  `clickFilters`, `ruleMatches`, `extractMmdb`.
- Wiring: `createApp`, `mountAdmin`, `validate`, `createDb`.
- **Everything in `auth/keys.ts`, and `extractToken`** — their arguments and
  return values *are* the secret.
- `geo.lookup` gets two inline debug lines, **not** a `span`: it is synchronous
  and sub-microsecond, and wrapping it would turn a sync call into a microtask
  on the hot path.
- `loadConfig` keeps `console.error` — the logger is configured from its result.

### Before / after

```ts
// apps/server/src/http/redirect.ts
function findActiveDomain(db: Db, hostHeader: string) {
  return span(
    "domain.findActive",
    async () => { /* …unchanged body… */ },
    {
      in: { host: hostHeader },
      out: (domain) => ({ domainId: domain?.id ?? null, host: domain?.host ?? null }),
    },
  )
}
```

```ts
// apps/server/src/http/api/users.ts — POST /:id/keys
reqLog().debug({ userId: id, label: body.label, expiresAt: body.expiresAt }, "key.create")
const created: ApiKeyCreated = { ...toApiKey(row), secret }
// `created` carries the plaintext secret and must never reach the logger.
reqLog().info({ userId: id, keyId: row.id, prefix: row.prefix }, "key.created")
return c.json(created, 201)
```

### Secrets and privacy — the part that must not be got wrong

**Three layers, each closing a different class of leak. None is sufficient alone.**

1. **Structural allowlist — the actual mechanism.** No logging call ever
   receives an object it did not construct. `span`'s `out` is a *mapper*, not a
   dumper, and is only invoked when debug is enabled. Nothing walks `c`,
   `c.var`, `c.req.raw.headers`, or a drizzle row. This is what keeps the
   bearer token and the minted `secret` out — a denylist cannot, because the
   sensitive field name in a future feature is not on it yet.
2. **pino `redact` paths — seatbelt against a naive dump.** `config`, `*.config`
   (high value: `c.var.config` carries `DATABASE_URL`, `LINQ_INITIAL_API_KEY`
   and `LINQ_MAXMIND_LICENSE_KEY` on *every* request context), plus `secret`,
   `keyHash`, `token`, `headers.authorization`, `headers["x-api-key"]` and
   their `*.`-prefixed forms. Stated limitation: pino's wildcard is
   single-level, so this covers depth 0 and 1 only.
3. **Stream-level scrub — closes the leaks the other two cannot reach.** A
   `replaceAll` over each serialised line, immediately before `write`, removing
   `LINQ_MAXMIND_LICENSE_KEY`, `LINQ_INITIAL_API_KEY`, `DATABASE_URL` and the
   DSN password. This is the **only** layer catching a secret embedded in a
   string we did not build:
   - `clicks/geo.ts:40` logs a raw `err` from a `fetch` whose URL embeds
     `license_key=…` — **a pre-existing leak this closes (D2)**.
   - `bun:sql`/drizzle put the full DSN with password inside connection-failure
     messages (`clicks/record.ts:17`).
   Path redaction cannot touch either: the secret is a substring of a message,
   not a field. Safe against chunk-splitting — pino issues one `write()` per line.

   **Residual risk, stated plainly:** per-request secrets (a bearer token, a
   freshly minted key) are not known at boot, so layer 3 cannot cover them.
   They are covered by layers 1 and 2, and by tests 8–9.

**No client IPs, ever.** `docs/adr/0001` keeps IPs out of the database; a
conventional access log would put the same personal data on disk and quietly
reverse that for the product as a whole. Request lines carry the request id and
the acting `userId` — never an address, never `X-Forwarded-For`. This is the one
place the "log request params at debug" rule is deliberately narrowed. No opt-in
flag: the answer is *never*, and ADR 0003 records it.

**Never log an HTTP response body.** `POST /api/v1/users/:id/keys` returns the
plaintext secret, so a generic response-body logger is one line away from
writing every minted key to disk. Responses log **status and duration only**.

### Volume — a number worth knowing

At info level a single redirect emits ~12 lines (~2.4 KB): request start/end
plus start/end for `findActiveDomain`, `findActiveLink`, `listRules`,
`recordClick`. At 1000 rps that is ~2.4 MB/s, so the default 100 MB budget
retains **roughly 40 seconds** of history.

This plan ships info level on the redirect path as specified. `span`'s optional
`level: "debug"` is the escape hatch: adding that one word to the four
redirect-path spans drops steady-state volume by ~70% and leaves the single
`response` line carrying `slug`, `status` and `ms` — which is most of what the
twelve lines reconstruct anyway. Worth revisiting once real traffic exists.

### The seven existing calls

| Now | Becomes |
|---|---|
| `bootstrap.ts:35` admin key | **stays `console.log`.** A plaintext admin key in a rotating file on a mounted volume, retained for 100 MB of history, is strictly worse than today. It reaches the operator's terminal and nothing else. Add `log.warn({ event: "bootstrap.admin_key_printed" })` — no secret — so the log records *that* one was minted |
| `bootstrap.ts:50` seeded domain | `log.info({ host }, …)` |
| `clicks/geo.ts:40` geo failure | `log.error({ err }, …)` — layer 3 strips the licence key. **Leak closed (D2)** |
| `clicks/record.ts:17` insert failure | `reqLog().error({ err, linkId, domainId }, …)` — `reqLog()` because `recordClick` runs inside the request's ALS context even though it is not awaited, so a failed insert correlates to the redirect that caused it |
| `config.ts:24` bad config | **unchanged** — the logger's own configuration is what failed to parse |
| `http/app.ts:38` unhandled error | `reqLog().error({ err }, …)` — the single place an error object is serialised |
| `main.ts:23` listening | `log.info({ port, version }, …)` |

### Shutdown

`main.ts` gains a `SIGTERM`/`SIGINT` handler awaiting `flushClicks()` then
`flushLogs()`. Buffered writes otherwise lose the last lines on `docker stop`,
and this is the natural home for the `flushClicks()` that until now only tests
called.

### Tests — ~16, in `apps/server/test/log.test.ts`

*Plumbing:* a default `createHarness()` request emits nothing and opens no file;
`x-request-id` generated when absent and echoed when valid; an id containing a
newline or over 64 chars is **replaced, not echoed** (log-injection guard);
**(5)** the same `reqId` appears on a request line and on a span emitted after
`await db.select()` — proves ALS survives Bun's SQL driver.

*Spans:* `start`+`end` with numeric `ms` and `ok: true`; a throwing span logs
`ok: false`, rethrows, and does not serialise the error.

*Secrets* — each asserts the literal value is absent from the captured stream:
the bearer token on an authenticated request; the `secret` from a key mint at
debug; `DATABASE_URL` / `LINQ_INITIAL_API_KEY` / `LINQ_MAXMIND_LICENSE_KEY`
across a full request; an `err.message` embedding `license_key=…` (**regression
guard for the `geo.ts` leak**); an `err.message` embedding the DSN with
password; `log.info({ config })` redacting the whole object.

*Privacy:* a redirect carrying `x-forwarded-for` at debug — the address appears
nowhere (**ADR 0003 guard**).

*Rotation:* `initLogger` against a temp file with `MAX_SIZE: "1k"`,
`RETAIN: 2`; write enough to roll; assert ≥2 files exist and old ones are
pruned. The only test touching disk, outside the repo tree, and the only way to
catch a pino-roll option being silently ignored.

Tests stay silent because `log` is `pino({ level: "silent" })` until
`initLogger` runs, and `initLogger` is called **only from `main.ts`** — never
from `createApp`. `createHarness` needs zero changes. `log.test.ts` passes an
in-memory sink to assert on output.

**Check when implementing:** `withRequestLog` now sets `x-request-id` on every
response — grep `admin-static.test.ts` and `redirect.test.ts` for exact-header
assertions first.

### ADR

`docs/adr/0003-logs-never-persist-client-ips.md`, same Context / Decision /
Consequences format as 0001 and 0002. Warranted for the same reason 0001 was:
without it, the first contributor asked for "proper access logs" adds
`x-forwarded-for` in a five-line PR that passes review, and 0001's guarantee
that *clicks are not personal data* quietly becomes false for the product. An
ADR is the cheapest thing that makes that PR get rejected.

pino/pino-roll gets **no** ADR — a dependency, reversible in an afternoon, with
no consequences outside `log.ts`.

---

## 3. shadcn/ui

```
cd apps/admin
bunx shadcn@latest init --base-color neutral
bunx shadcn@latest add button input label select checkbox table card \
  badge dialog dropdown-menu popover command sonner skeleton
```

Writes `components.json` and `components/ui/*.tsx`; adds
`class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css`,
`lucide-react` and the `@radix-ui/*` packages. `apps/admin/tsconfig.json`
already has `"@/*": ["./*"]`, the alias the CLI expects. **Needs network access.**

**Tailwind v4 groundwork.** `app/globals.css` is currently the single line
`@import "tailwindcss";`; `init` replaces it with the shadcn v4 token block.
Follow-ups:

- `app/layout.tsx` — swap hardcoded `bg-neutral-50 text-neutral-900` on `<body>`
  for `bg-background text-foreground`.
- `components/stats-panel.tsx:100,112,113` — replace hardcoded `#e5e5e5` /
  `#171717` / `#a3a3a3` with the `--chart-1`/`--chart-2` tokens, so charts
  follow the theme.

**Mapping.** `components/ui.tsx` (218 lines, 13 exports, 10 consumers) is deleted:

| Today | Becomes |
|---|---|
| `Button` (primary/secondary/danger/ghost) | shadcn `button` — `default`/`outline`/`destructive`/`ghost` |
| `Input`, `Checkbox`, `Badge`, `Card`, `Table`/`Cell` | shadcn equivalents (`Card` unpacks into `CardHeader`/`CardTitle`/`CardAction`/`CardContent`; `Table` into `TableHeader`/`TableRow`/`TableHead`/`TableBody`/`TableCell`) |
| `Select` (native `<select>`) | shadcn `select` (Radix) — the largest mechanical change, across 7 files |
| `Field` | kept as `components/field.tsx`, rebuilt on shadcn `Label` |
| `QueryState`, `CopyButton`, `When` | kept in `components/`, not shadcn concepts |
| `cx` | deleted — shadcn's `cn()` (clsx + tailwind-merge) resolves conflicting Tailwind classes, which `cx` cannot |

**Two defects to fix during the port (D3, D4):**

- `components/ui.tsx:25` — `Button` hardcodes `type="button"` *before* the props
  spread, so a caller's `type="submit"` silently wins.
- `app/users/page.tsx:70` — the `<>` inside `rows.map` has no `key` (it sits on
  the inner `<tr>`); becomes a keyed `<Fragment>`.

**Unlocks** (all absent today — the app has no portal/overlay primitive at all):
a confirmation `Dialog` before archiving a domain or revoking a key, `sonner`
toasts replacing six hand-rolled inline error boxes, and the `Popover`+`Command`
combobox item 1 needs.

**Lint:** run `bunx biome check --write .` after generating. If the vendored
files keep fighting, exclude `apps/admin/components/ui/**` in `biome.json`
rather than editing generated source.

---

## 4. Permission-aware controls

**Root cause.** `components/app-shell.tsx:21` hand-copies the role ladder
(`RANK`) instead of importing `roleAtLeast` from `@linq/shared`, so each page
invented its own gate. Five gaps:

| # | Location | Problem |
|---|---|---|
| 1 | `app/links/page.tsx:154` | Archive/Restore shown to any `author` on **every** row; server needs owner-or-editor → 403 |
| 2 | `app/links/new/page.tsx` | **No gate at all** — `AppShell`'s `me` is discarded at `:19`; a viewer gets a live create form |
| 3 | `app/users/page.tsx` | **No page-level admin gate**; only the nav link is hidden, so a direct URL renders the whole page for any role |
| 4 | `app/links/detail/page.tsx:197` | **(D1)** Owner `Select` `disabled` compares `link.ownerId !== ownerId` — draft state, not the current user. Enabled for an editor the server forbids, and once a non-admin changes it, it **disables itself and traps the value** with no way back short of a reload |
| 5 | everywhere except `detail` | Only `detail/page.tsx:54` models ownership at all |

**Fix — one shared predicate module.** New `packages/shared/src/permissions.ts`,
re-exported from `index.ts`, of pure functions over `{userId, role}`:

```ts
can.createLink(p)                 // author+
can.editLink(p, { ownerId })      // editor+ OR (author AND owner)
can.transferLink(p, { ownerId })  // admin OR (owner AND author+)
can.manageDomains(p)              // admin
can.manageUsers(p)                // admin
can.changeRoleOf(p, targetId)     // admin AND not self
can.disableUser(p, targetId)      // admin AND not self
```

These encode rules that today live only in `apps/server/src/http/api/*.ts`.

- **Server** — `auth/permissions.ts` keeps `assertRole`/`assertOwnerOrRole` as
  throwing wrappers that delegate. `assertOwnerOrRole` is only ever called with
  its default `min = "editor"` (`links.ts:190`, `links.ts:217`, `rules.ts:41`),
  so `can.editLink` covers all three exactly. The inline transfer guard at
  `links.ts:195-197` becomes `can.transferLink`. **Behaviour must not change** —
  `test/permissions.test.ts`, `test/users.test.ts` and `test/links.test.ts` are
  the regression proof.
- **Admin** — delete the local `RANK`/`atLeast`, import `can` from
  `@linq/shared`, and apply it to gaps 1–5: per-row `can.editLink` on the list,
  a page-level guard for `new` and `users`, and `can.transferLink(me, link)` for
  the Owner select (which needs `userId` threaded into `SettingsCard`, whose
  props at `:100-105` omit it).

Gating stays cosmetic — the server check is the real one — but the UI should
stop offering actions it knows will 403.

**Tests:** new unit suite for `can.*` (~12 assertions over the role × owner
matrix, mirroring `test/permissions.test.ts`), plus the existing server suites
proving no behaviour change.

---

## Sequencing

Items 3 and 4 touch the same ten files, and item 1's picker needs shadcn's
Popover/Command — so:

1. **Logging** — server only, independent.
2. **shadcn foundation** — `init`, `add`, port the 13 exports across 10
   consumers. Largest mechanical diff, mostly native `<select>` → Radix.
3. **Permissions** — shared module, server delegation, then the five UI gaps
   applied to the now-shadcn components.
4. **Tag picker** — the combobox, reused for filtering and tag entry, plus the
   search debounce.

## Verification

```bash
bun test apps/server/test      # 162 existing + ~28 new, green, no log spew
bunx tsc -b --force            # exit 0
bunx biome check .             # exit 0 — check the exit code, not the tail
bun --filter @linq/admin build # exports all 7 pages
```

Logging, against real Postgres (`docker compose -f docker-compose.example.yml up`):

```bash
curl -i -H 'Host: localhost:3000' 'localhost:3000/<slug>?a=1'
tail -f data/logs/linq.log | jq

# the three checks that matter — all must print nothing
grep -i 'bearer\|linq_[A-Za-z0-9_-]\{20,\}' data/logs/linq.log
grep -i 'license_key\|postgres://' data/logs/linq.log
grep -E '[0-9]{1,3}(\.[0-9]{1,3}){3}' data/logs/linq.log

# rotation fires and prunes
for i in $(seq 1 50000); do curl -s -o /dev/null -H 'Host: localhost:3000' localhost:3000/nope; done
ls -la data/logs/
```

Admin UI at `localhost:3000/admin` — mint one key per role and confirm:

- **viewer** — no "New link"; `/admin/links/new/` and `/admin/users/` reached by
  direct URL refuse rather than rendering a live form; no Archive on any row;
  rules editor read-only.
- **author** — Archive only on owned rows; can hand over its own link, and the
  Owner select stays usable after changing it.
- **editor** — can edit any link; Owner select **disabled** on links it does not
  own.
- **admin** — everything, except its own role select and its own Disable button.

Tag picker: the dropdown lists tags with counts from `/v1/tags`, selecting two
filters to links carrying **either**, and the wire format is still `?tags=a,b`.

## Risks

- **The shadcn CLI needs network access** at implementation time.
- **`init` rewrites `globals.css`**, and `layout.tsx` and `stats-panel.tsx`
  hardcode colours outside any token system — expect a visual pass after.
- **ALS propagation through Bun's SQL driver is unproven** — test 5 is the
  gate, and the fallback is documented above.
- **Server permission behaviour must not shift** while `assertRole` /
  `assertOwnerOrRole` are refactored to delegate. Run the suites before and after.
