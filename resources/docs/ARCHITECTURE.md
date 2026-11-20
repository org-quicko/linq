# Architecture

How linq's pieces fit together today. For terms, see `CONTEXT.md`; for why a
decision was made, see `resources/docs/adr/`.

## Shape

One Bun workspace, two apps and a shared package: `apps/server` (Hono, on
Bun's HTTP server) is the API, the redirect handler and the CLI; `apps/client`
(Next.js, exported static) is the Client UI; `packages/shared` holds the zod
schemas, types and permission rules both sides import, so the server's
enforcement and the client's form validation and UI gating cannot drift apart.
One Postgres database is the only required dependency — linq never runs
Postgres itself. Redis and Caddy are optional and each fails loud once
configured (`AGENTS.md`).

## The server process

`main.ts` wires everything explicitly, in order: load config (exits on a bad
one) → init the logger → open the db → run migrations → start Caddy sync →
bootstrap (mint the first admin key and seed the default domain, both gated on
"table is empty" so a restart never repeats them, then reconcile Caddy's
routes) → start the cache, link-metadata fetcher and visit pipeline → build the
Hono app → listen. `SIGTERM`/
`SIGINT` drain in-flight visit inserts and buffered log writes before exiting,
so `docker stop` cannot silently drop the tail of either.

```
config ──► logger ──► db ──► migrations ──► Caddy ──► bootstrap ──► cache/metadata/visit pipeline ──► Hono app ──► listen
  │                                                       │
  └─ exits on a bad value                                 └─ admin key + default domain, only when their tables are empty;
                                                             Caddy reconcile, every boot
```

`createApp` (`app.ts`) builds every service and controller exactly once,
handing each its dependencies through the constructor (one instance per app,
no per-request construction, nothing global), and returns only the app: no
service is needed outside it. `main.ts` starts the clients and the visit
pipeline, passes them in, and drains the pipeline on shutdown. Each request flows
`route → controller → service`: a route function maps paths to controller
methods, a controller validates (`RequestUtil.parse`), loads what the permission
question needs, calls `authorize`, and hands the rest to its service, which
owns every query, business rule and side effect (cache invalidation, Caddy
sync). Only the authenticated `principal` rides on the request context.

It mounts routes in an order that matters: `/api/*`
first, then `robots.txt`/`llms.txt`, then the exported Client UI at its configured
base path, and the catch-all redirect handler last — so a reserved path can never
be shadowed by a slug of the same name, and the UI's first segment is never read
as one either.

```
/api/*  ──►  robots.txt, llms.txt  ──►  Client UI base path  ──►  catch-all redirect
(reserved paths win — a slug can never shadow one of these)
```

## Auth: the key is the principal

There are no user accounts. An API key (`apiKeys` table) carries its own name
and role directly, so authenticating is one indexed lookup and no join
(`resources/docs/adr/0011`). `authenticate` (`middleware/authenticate.ts`) reads
`Authorization: Bearer <key>` or `X-Api-Key`, hashes it, and looks up the row;
a missing, unknown or expired key is a 401. Only the key's sha256 is stored —
a lost key cannot be recovered, only reissued.

Roles are linear — `viewer < editor < admin` — and every check goes through
`@linq/shared`'s `can`/`roleAtLeast`, wrapped on the server by
`middleware/authorize.ts`'s `authorize`. An editor creates and edits any
link; archiving, restoring and purging a link are admin-only. Links carry no
reference to the key that created them, so revoking a key never touches its
links (`resources/docs/adr/0016`).

```
request
  │  Authorization: Bearer <key>  or  X-Api-Key
  ▼
authenticate (hash + look up api_keys) ──miss/expired──► 401
  │ hit
  ▼
principal { keyId, role, name }
  │
  ▼
route handler's assert*(principal, …) ──fails──► 403
  │ passes
  ▼
handler runs
```

## Data model

Six tables, one migration tool (Kysely runs the ordered migrations in
`apps/server/src/db/migrations/`; `kysely-codegen` writes `src/db/types.generated.ts`). A domain hosts links; a link belongs to a domain and
carries no reference to the key that created it (`resources/docs/adr/0016`); a link may
carry ordered rules (alternate destinations gated on platform or query-param
conditions, first match wins — `utils/RuleMatchUtil.ts`) and styled QR codes.
Archiving a link or domain is a status flip, never a delete: a slug is
reserved for as long as its row exists, so an archived slug can never be
hijacked by a new link (`resources/docs/adr/0002`). Only a `Purge`, admin-only, destroys
the row and its visits for good.

Visits are the one high-volume table, and the one place traffic ever touches
the client. Recording is fire-and-forget (`VisitService.record`) — a redirect
never waits on the insert, and a failed insert never turns a working link
into an error. Each visit is emitted as an OpenTelemetry log record whose only
exporter writes it to `visits` the moment it arrives (`resources/docs/adr/0022`),
capped by `LINQ_VISIT_MAX_PENDING` inserts in flight. That pipeline is the
app's one `VisitPipeline` (`telemetry/visits/`), which owns the in-flight inserts;
`main.ts` starts it and hands it to `createApp`, `VisitService` records through
it, and `main.ts` calls its `flush()` on shutdown to drain them. It never stores the
client's IP address, in the row or the
request log (`resources/docs/adr/0001`, `resources/docs/adr/0003`). `visit_days` and
`visit_counts` are pre-aggregated rollups that every list and overview reads
instead of scanning `visits`; they're maintained entirely by Postgres
triggers on insert, not application code, so `visits` stays the single
source of truth with no rollup job to fall behind (`resources/docs/adr/0007`).

## The redirect hot path

`routes/RedirectRoute.ts` is the one handler most requests hit. For a host it looks
up the active domain, then the active link for the slug (rules bundled in, so
one hit answers the whole redirect), through an optional cache
(`through()` in the same file — cache miss falls back to the query and writes
the answer back, including a negative "no such thing" result, so a flood of
404s costs one query per TTL rather than one per request). An expired link is
treated as an orphan rather than filtered in SQL, because a cached entry can
outlive its own expiry with nothing to invalidate it. Reserved paths (`/api`,
the configured Client UI first segment, …) are checked before any of this, by
first path segment.
Rule matching (`utils/RuleMatchUtil.ts`) is synchronous and ANDs a rule's conditions;
the first rule that matches wins, otherwise the link's own destination is
used. If the link forwards its query, the caller's query merges in and the
link's own preset params overwrite anything that collides on either side.

A link-preview crawler's user agent gets a small HTML page carrying the
link's own title as Open Graph tags, instead of the 302 — never the
destination's title, since fetching the destination synchronously on every
crawler hit would make the redirect page as slow as its target
(`resources/docs/adr/0014`). An ordinary destination gets a name, description and
favicon in the background instead, fetched once and stored on the link
(`clients/LinkMetadataClient.ts`), with an SSRF guard that refuses private, loopback and
link-local IPs so a destination can't be used to probe the server's own
network.

```
request  (Host header + slug)
  │
  ▼
reserved path? (/api, Client UI, robots.txt, llms.txt)  ──yes──►  routed there, never reaches this handler
  │ no
  ▼
cache lookup (through())  ──hit──►  cached target  ─────────────────────────────┐
  │ miss                                                                        │
  ▼                                                                             │
resolve domain (Host)  ──unknown / archived──►  untracked 404                   │
  │ active                                                                      │
  ▼                                                                             │
resolve link (slug, rules bundled in)  ──unknown / archived / expired──►  orphan visit ──► domain's fallback_url or 404
  │ active                                                                      │
  ▼                                                                             │
rule matching (RuleService.ts, first hold wins)  ──►  destination  ◄────────────┘
  │
  ▼
forward_query?  ──yes──►  merge caller's query, link's preset params win on collision
  │
  ▼
crawler user agent?  ──yes──►  OG preview HTML (link's own title, never fetched from the destination)
  │ no
  ▼
302 redirect  +  fire-and-forget visit (never blocks the response):
                 OTel log record ──► VisitTableExporter ──► INSERT INTO visits
```

## Cache, Caddy, metadata: the same shape three times

Redis (`LINQ_REDIS_URL`) is optional; unset, redirect lookups cache in an
in-process LRU instead, so nothing else has to be running. Whichever backend
is picked, once configured it must be reachable at boot or the server refuses
to start — a Redis that goes down *after* boot degrades to hitting Postgres
directly rather than failing requests (`resources/docs/adr/0009`). Caddy sync
(`LINQ_CADDY_ADMIN_URL`) is the same shape: when set, every domain
create/archive/reactivate/purge pushes a route to Caddy's admin API so a
custom domain resolves over HTTPS without hand-editing Caddy's config
(`resources/docs/adr/0012`); Caddy's own routes are wiped on its restart, so `bootstrap`
reconciles all of them once at linq's own boot. Link-metadata fetching
(`LINQ_FETCH_LINK_METADATA`) follows the same pattern too.

Each is a port with its implementations as classes. The cache port lives in
`adapters/cache/`, with one adapter per backend (`RedisCacheAdapter`, which
owns Bun's native `RedisClient` directly, `MemoryCacheAdapter`,
`NoopCacheAdapter`, chosen by `CacheAdapter.start`); Caddy and link metadata
follow the same shape in `adapters/caddy/` and `adapters/linkMetadata/`
(`AdminApiCaddyAdapter` over `clients/CaddyClient`, `HtmlLinkMetadataAdapter`
over `clients/LinkMetadataClient`, each with a `Noop…` one, chosen by
`CaddyAdapter.start` and `LinkMetadataAdapter.start`). Each adapter builds its
own client; callers only ever hold the adapter. `createApp` wraps all three
(and `bootstrap` its Caddy) in a guarding decorator from `adapters/decorators/` (`GuardedCache`, `GuardedCaddy`,
`GuardedLinkMetadata`) that turns any failure into "act as if this feature is
off" rather than letting a down dependency break a route it merely
optimises — a domain mutation, a redirect, or a link creation must all
succeed whether or not Redis, Caddy or the destination site are currently
reachable.

`db/db.ts` defines the process's plain Kysely `db` instance and the `Db`
handle type; `db/index.ts` re-exports them. Runtime imports validate environment configuration and construct
the pool; connections open on first use. Entry points share the instance and
close it on exit. Services receive their handle through constructors, and
tests import only the type and supply isolated PGlite handles. PostgreSQL
sessions retain the configured search path, UTC timezone and numeric bigint
conversion. Neither PostgreSQL nor Redis has an application wrapper client.

## Observability

The `Logger` class in `libs/logger.ts` owns the process-wide pino logger,
redaction, rotation, request context and flushing. It stays silent until
`main.ts` calls `Logger.init`, so importing it from a test or script writes nothing. Every
request gets a child logger carrying a request id, held in `AsyncLocalStorage`
rather than threaded through every function signature. `@Log()` decorates a method as a named
operation with a start/end pair and its duration, logging the operation name
always and its structured input/output only when debug is enabled. A caught
error is rethrown without being serialised at each level it passes through;
only `app.onError` logs it once, with the request id attached. Known secrets
(the DB and Redis DSNs, in raw, URL-encoded and JSON-escaped form) are
scrubbed from every line before it's written, on top of pino's own
path-based redaction.

Expected failures use `HttpError` and the shared
`{ error: { code, message, details? } }` envelope. The Client UI turns this
into `ApiError`, and RTK Query passes status, code and message to its callers.
A 401 disconnects the saved server and returns to the connection screen;
other mutation failures use action-specific fallback toasts. Validation
details are currently not displayed as field errors.

The raw visit list first pages IDs in `(visited_at DESC, id DESC)` order,
then loads full rows for that page. Migration `0009` adds the global index
that supports this ordering; domain/link indexes alone cannot serve it.
Offsets still cost work proportional to the number of skipped index entries.

## The Client UI

A Next.js app, exported as static files, that is a client of the API — never
assuming it's talking to the server that happens to be serving it
(`resources/docs/adr/0006`). It holds a list of "servers" (name, absolute URL, API key)
in `localStorage` and calls whichever one is selected; every call is
cross-origin by construction, so the server enables CORS on `/api/*` and
issues no cookies — the key is the only credential, and it travels in a
header the browser never sends automatically. `lib/api.ts`'s `api()` is the
one call site: it attaches the key, and treats "no server connected" and a
401 identically, redirecting to the landing page without discarding the
saved server record (only the key is bad, not the URL).

Two builds come from one codebase: `build:client` targets the configured
sub-path the server serves at (`routes/AdminRoute.ts` mounts it, path-
traversal-checked, ahead of the redirect catch-all); `build:client:standalone`
targets a domain root for hosting anywhere as plain static files. The combined
build bakes `LINQ_CLIENT_BASE_PATH` into its static files (`/home` by default),
and the server reserves that path's first segment so it cannot become a short
link. `docker/dockerfiles/Dockerfile` accepts the value only as an explicit build argument and
must be rebuilt when it changes; it does not read `.env`. Neither UI build bakes
in an API URL.

With `LINQ_APP_HOST` set, the combined UI answers only on that host and falls
through to the redirect handler everywhere else, which is what lets the base path
be `/` (`resources/docs/adr/0019`). The app host is never a domain row; `/api/*` stays
host-agnostic.

Server state is Redux Toolkit Query (`lib/store/`) — one `apiSlice` per
resource, `configureStore` wiring it in. Client-only state (the saved
servers, theme) stays in `localStorage`, read through `lib/servers.ts`,
independent of the RTK Query cache.
