# Repo map

Where everything lives. The pieces and how they fit are in
[ARCHITECTURE.md](ARCHITECTURE.md).

## The workspace

```
feature-linq/
├─ apps/
│  ├─ server/     @linq/server — Hono API, redirect handler, CLI
│  └─ client/     @linq/client — the Next.js Client UI, exported static
├─ packages/
│  └─ shared/     @linq/shared — zod schemas, types and permission rules both apps import
├─ resources/
│  ├─ docs/       architecture, this map, and adr/: decisions that are hard to reverse, and why
│  ├─ sql/        the schema as a pg_dump, kept in sync with the migrations
│  └─ openapi/    the HTTP API spec, kept in sync with the code
├─ docker/        deployment shapes
├─ logo/          wordmark for the README, light and dark (the app's copies are in apps/client/assets)
└─ .agents/       skills: step-by-step procedures for agents working here
```

One Bun workspace (`workspaces: ["apps/*", "packages/*"]`), one `bun.lock`.
`tsconfig.json` covers `packages/shared` and `apps/server`; `apps/client` is
a separate Next.js project with its own config. `bun run typecheck` runs
`tsc -b --force` across both.

## Root files

| Path | What it is |
|------|------------|
| `package.json` | Workspace root. Delegates every script (`dev`, `test`, `db:migrate`, `db:codegen`, …) to the member that owns it via `bun --filter` |
| `AGENTS.md` | What isn't obvious from the code: running it, Redis/Caddy's fail-loud behaviour, docs conventions |
| `CLAUDE.md` | Points Claude at `AGENTS.md` and `.agents/skills/` |
| `CONTEXT.md` | The domain glossary — terms only, no implementation |
| `README.md` | Local setup, Docker, deploying the Client UI |
| `biome.json` | Lint/format config (`bun run lint` / `format`) |
| `.env.example` | Every environment variable, with a comment; `config.ts` is the schema that actually enforces them |

## `apps/server/src/`

Layered `routes → controllers → services`, with clients of external systems in
`clients/`. A route file is a function (`linkRoutes(linkService)`, …) that
builds its controller once and maps each path to a controller method. A
controller class has one arrow-function property per endpoint taking a Hono
`Context`: it validates with `parseRequest`, loads what the permission question
needs, calls `authorize`, and calls its service. A service class holds every
query, business rule and side effect (cache invalidation, Caddy sync).
`createApp` builds every service and controller exactly once and injects them
through constructors; a service that needs another service gets that same
instance. Only `principal` rides on the request context. Every conversion from
one shape to another (a database row to its API type, and so on) lives in
`converters/`. `converters/`, `utils/`, `clients/`, `libs/`, `middleware/`,
`routes/`, `controllers/` and `services/` each export through an `index.ts`
barrel.

Inside any class (services, controllers, clients, the visit exporter, utils), a
helper only that class uses is a `private` method (`private static` when it
reads no instance state), placed after every public method; not a
module-level function.

```
apps/server/src/
├─ main.ts  app.ts  bootstrap.ts  config.ts
├─ routes/        AdminRoute AnalyticsRoute DomainRoute KeyRoute LinkRoute LlmsRoute QrCodeRoute RedirectRoute VisitRoute
├─ controllers/   AnalyticsController ApiKeyController DomainController LinkController LlmsController QrCodeController RedirectController VisitController
├─ services/      AnalyticsService ApiKeyService DomainService LinkService LlmsService QrCodeService RedirectService RuleService VisitService
├─ adapters/      cache/ CacheAdapter GuardedCache {Redis,Memory,Noop}CacheAdapter
├─ clients/       DbClient RedisClient CaddyClient LinkMetadataClient
├─ middleware/    authenticate authorize rateLimit requestLogger requestParser
├─ converters/    one folder per resource
├─ utils/         one static class per file
├─ libs/          logger errors
├─ db/            migrations/ migrate.ts types.generated.ts
├─ cli/           createKey migrate codegen
└─ types/         pino-roll.d.ts
```

| Path | What it holds |
|------|----------------|
| `main.ts` | Boot sequence: config → logger → db → migrations → bootstrap → cache/Caddy/metadata → app → Caddy reconcile → listen. Owns shutdown draining (`visitService.flush()`) |
| `app.ts` | `createApp`: builds every service and controller once, guards the clients, the error envelope, CORS/body limit, `/api/v1`, robots.txt, llms.txt, the Client UI, and the catch-all redirect, in the order that keeps the catch-all from shadowing anything reserved. Returns `{ app, domainService, visitService }` |
| `bootstrap.ts` | First-boot admin key mint and default-domain seed, each gated on its table being empty. Runs before `createApp`, so it builds its own `ApiKeyService` |
| `config.ts` | The zod schema for every `LINQ_*`/`DATABASE_URL` env var; exits the process on a bad one. |
| `routes/` | One function per resource returning its Hono sub-app(s): `analyticsRoutes`, `domainRoutes`, `keyRoutes` (`/keys` and `/me`), `linkRoutes` (`/links`, its `/:id/rules`, and `/tags`), `qrCodeRoutes`, `visitRoutes`, `llmsRoutes` (`GET /llms.txt`, see `resources/docs/adr/0013`), `redirectRoutes` (the catch-all hot-path redirect and link-preview OG page). `AdminRoute`'s `mountAdmin` stays a plain function: it is static-file wiring (the exported Client UI at `LINQ_CLIENT_BASE_PATH`, path-traversal-checked, only on `LINQ_APP_HOST` when that is set) with no service behind it |
| `controllers/` | One class per resource, one arrow-function property per endpoint taking a Hono `Context`: `AnalyticsController`, `ApiKeyController` (keys and `/me`), `DomainController`, `LinkController` (links, their rules, tags), `LlmsController`, `QrCodeController`, `RedirectController`, `VisitController` |
| `services/` | Business rules and Kysely queries, classes taking their dependencies in the constructor: `ApiKeyService` (mint, look up by token, CRUD), `LinkService` (links, tags, rules, slug generation, cache invalidation), `DomainService` (domains, the archive lock, cache and Caddy sync, `reconcileCaddy`), `RuleService` (rule storage, bound to a db or a transaction: `new RuleService(tx)`), `RedirectService` (domain/target resolution, read through the cache), `VisitService` (fire-and-forget `record` through an OpenTelemetry log pipeline whose exporter inserts into `visits`, `flush`, the raw-log list; see `resources/docs/adr/0022`), `AnalyticsService` (rollup vs. raw-log reads), `QrCodeService`, `LlmsService` |
| `converters/` | One folder per resource (`link/`, `domain/`, `apiKey/`, `rule/`, `qrCode/`, `visit/`, `analytics/`, `redirect/`, `llms/`), one class per file with the same name, e.g. `link/LinkJoinedRowToLinkConverter.ts`. Instance `convertFrom` and `convertTo` methods cover only the directions needed. |
| `utils/` | Helpers, one static class per file, named like the file, with only `static` methods (call them as `SlugUtil.generateSlug(...)`): `UrlUtil` (`shortUrl`, `clientPath`, `isAppHost`, `mergeQuery`), `SlugUtil` (`generateSlug`, `isReservedSlug`), `FilterUtil` (link, QR code and visit list filters), `DateTimeUtil`, `CacheKeyUtil`, `HtmlUtil`, `MarkdownUtil`, `HashUtil`, `RuleMatchUtil`, `UserAgentUtil` (bot, preview-crawler, platform, OS and browser detection), `RequestUtil` (`read`: a request's `json` body, `query` or `param`s exactly as Hono's validator reads them, malformed-JSON 400 included). None touches the database; only `RequestUtil` reads a Hono `Context` |
| `middleware/` | `authenticate.ts` (`authenticate(apiKeyService)`: resolves the key and sets `c.var.principal`, which is typed globally here), `authorize.ts` (`authorize`), `rateLimit.ts` (per-key limit), `requestParser.ts` (`parseRequest`, zod validation in linq's error envelope, and `idParamSchema`), `requestLogger.ts` (`requestLogger(clientBasePath)`: the request/response log pair and the per-request async logging scope) |
| `adapters/` | linq's ports implemented over clients. Services depend on adapters, never on a client directly. `cache/`: the `Cache` port with `CacheAdapter.start` and `CacheAdapter.readThrough`, the `GuardedCache` decorator, and one adapter per backend: `RedisCacheAdapter` (over `RedisClient`), `MemoryCacheAdapter`, `NoopCacheAdapter`; see `resources/docs/adr/0009` |
| `clients/` | Clients of external systems, each a port with class implementations. `DbClient.ts` (the `Db` type, a plain Kysely instance, and `DbClient.start(config)`), `RedisClient.ts` (one Redis connection that stores strings; only `RedisCacheAdapter` uses it), `CaddyClient.ts` (the `Caddy` port, `CaddyClient`, `NoopCaddyClient`, `GuardedCaddy`; see `resources/docs/adr/0012`), `LinkMetadataClient.ts` (the `MetadataFetcher` port, `LinkMetadataClient` with its SSRF guard, `NoopLinkMetadataClient`, `GuardedLinkMetadataClient`) |
| `libs/` | `logger.ts` (pino, `Logger.forRequest()`, `@Log()`, secret scrubbing) and `errors.ts` (`HttpError`, Hono's `HTTPException` rendering linq's error envelope) |
| `db/` | `migrations/` (ordered Kysely migrations), `types.generated.ts` (Kysely query types), `migrate.ts` (runs migrations in `LINQ_DB_SCHEMA` at boot) |
| `cli/` | `createKey.ts` (`bun run key:create`, mints a key without a restart through `ApiKeyService.create`), `migrate.ts`, `codegen.ts` |
| `types/` | Ambient declarations for untyped dependencies (`pino-roll.d.ts`) |

## `apps/client/`

| Path | What it holds |
|------|----------------|
| `app/` | Next.js App Router pages, one directory per route: `overview/`, `links/` (+ `new/`, `detail/`, `trash/`), `domains/` (+ `trash/`), `orphans/`, `visits/`, `analytics/`, `archives/`, `settings/` (+ `domains/`, `keys/`), `dev/components/` (a component playground) |
| `components/` | Feature components (`link-form-dialog.tsx`, `rules-editor.tsx`, `qr-form-dialog.tsx`, `server-switcher.tsx`, `server-form.tsx`, …); `patterns/` for reusable page-building blocks (`row-card`, `stat-card`, `page-header`, `empty-state`, `domain-picker`, …); `ui/` for the shadcn-derived primitives |
| `lib/api.ts` | The one fetch call site — attaches the active server's key, normalizes a 401 into "disconnect and redirect" |
| `lib/servers.ts` | The saved-servers `localStorage` model: list, active, probe (health + `/me` check before saving), legacy single-key migration. See `resources/docs/adr/0006` |
| `lib/store/` | Redux Toolkit: `index.ts` wires the store, `api.ts` the RTK Query base, one file per resource (`domains.ts`, `links.ts`, `keys.ts`, `qr-codes.ts`, `stats.ts`) |
| `lib/hooks.ts`, `lib/qr.ts`, `lib/base-path.ts`, `lib/utils.ts` | Shared client-only helpers — hooks, QR rendering, the build-time base-path prefixer for `next/link`-bypassing redirects, misc |
| `test/` | Client-side unit tests, mirroring `lib/` |

## `packages/shared/src/`

Four folders, one PascalCase file per area, each with an `index.ts` barrel;
`src/index.ts` re-exports all four. Both apps import only from
`"@linq/shared"`, never a deep path. Nothing here imports from either app.

| Path | What it holds |
|------|----------------|
| `constants/` | Fixed vocabularies and limits, `<Area>Constant.ts`: `SlugConstant` (`RESERVED_SLUGS`, `SLUG_PATTERN`), `PlatformConstant` (`PLATFORMS`), `QrCodeConstant` (`QR_PATTERNS`), `AnalyticsConstant` (`ANALYTICS_*`, `NOT_RECORDED`, `MAX_RANGE_DAYS`), `VisitConstant` (`BOT_CLASSIFICATION_REASONS`), `ResourceConstant` (`RESOURCE_STATUSES`), `PermissionConstant` (`ACTIONS`, `SUBJECTS`, `PRESETS`, `claimsForPreset`), `ErrorConstant` (`ERROR_STATUS`) |
| `schemas/` | Every zod schema and schema builder, `<Area>Schema.ts`: `LinkSchema`, `DomainSchema`, `ApiKeySchema`, `QrCodeSchema`, `RuleSchema`, `VisitSchema`, `AnalyticsSchema`, `PermissionSchema` (claim/action/subject/preset), `CommonSchema` (`uuidSchema`, `slugSchema`, `urlSchema`, `hostSchema`, `tagSchema`, `paginationSchema`, `csvList`, `platformSchema`, `resourceStatusSchema`) |
| `types/` | Every type, `<Area>Type.ts`: API responses, request bodies (`z.infer` of a schema), database rows, plus `CommonType` (`Platform`, `Os`, `Browser`, `Pagination`, `Page`, `ResourceStatus`), `PermissionType` (`Action`, `Subject`, `Claim`, `AppAbility`, `KeyPreset`, `Actor`, `Principal`), `ErrorType` (`ErrorCode`, `ErrorBody`) |
| `utils/` | Shared logic, one static class per file like the server's: `PermissionUtil` (`defineAbility`, `can`, `claimsEqual`, `presetForClaims`, `resolveClaims` — what both `middleware/authorize.ts` on the server and the Client UI's gating read), `LinkUtil` (`destinationTitle`) |

Imports flow one way: `schemas` read `constants`; `types` read both (type-only);
`utils` may read any of them.

## `resources/`

| Path | What it is |
|------|------------|
| `sql/schema.sql` | The schema as `pg_dump --schema-only` output. Loads into any PostgreSQL, imports into ERD tools (pgAdmin, DBeaver, DataGrip, dbdiagram) |
| `openapi/linq.openapi.json` | The HTTP API as OpenAPI |
| `docs/ARCHITECTURE.md` | How the pieces fit together today, with flow diagrams for boot, auth and the redirect hot path |
| `docs/repo-map.md` | This file |
| `docs/adr/000N-*.md` | One decision per file, numbered sequentially |

## Deployment

| Path | What it is |
|------|------------|
| `docker/dockerfiles/` | `Dockerfile`, the one published image: server + built Client UI, UI at `/` for `LINQ_APP_HOST` by default, or at a build-time `LINQ_CLIENT_BASE_PATH` such as `/home` |
| `docker/examples/dockerfiles/` | `Dockerfile.server` (server only, configured UI path 404s), `Dockerfile.client` (standalone client build), and `caddy/`, the Caddy config template the Caddy compose files mount (see `resources/docs/adr/0012`) |
| `docker/examples/docker-compose/` | One compose file per deployment shape — bundled or external Postgres, with or without Redis/Caddy, client served together or standalone, or on an app host of its own (`11-app-host.yml`) |

## Agent tooling

`.agents/skills/` holds the skills: `linq-dev` (start the dev environment),
`linq-db-migration` (add and verify a Kysely migration), `linq-adr` (write a
new ADR), `linq-backend` (add or change an `apps/server` API resource),
`linq-frontend` (add or change an `apps/client` UI feature).
