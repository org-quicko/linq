# Repo map

Where everything lives. The pieces and how they fit are in
[architecture.md](architecture.md).

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

Layered `routes → services`: routes are thin Hono
wiring, services hold every query and business rule, and neither reaches
around the other. `libs/`, `middleware/`, `routes/` and `services/` each
export through an `index.ts` barrel.

| Path | What it holds |
|------|----------------|
| `main.ts` | Boot sequence: config → logger → db → migrations → bootstrap → cache/Caddy/metadata → app → listen. Owns shutdown draining |
| `app.ts` | `createApp`: wires dependencies onto `c.var`, the error envelope, CORS/body limit, `/api/v1`, robots.txt, llms.txt, the Client UI, and the catch-all redirect, in the order that keeps the catch-all from shadowing anything reserved |
| `bootstrap.ts` | First-boot admin key mint and default-domain seed, each gated on its table being empty |
| `config.ts` | The zod schema for every `LINQ_*`/`DATABASE_URL` env var; exits the process on a bad one. Also `isReservedSlug`, `isAppHost`, `clientPath` |
| `routes/` | One Hono sub-app per resource (`AnalyticsRoute`, `DomainRoute`, `KeyRoute` (+ `meRoute`), `LinkRoute` (+ `tagRoute`), `QrCodeRoute`, `RuleRoute`, `VisitRoute`), plus `RedirectRoute` (the hot-path redirect handler and link-preview OG page), `LlmsRoute` (`GET /llms.txt`, see `resources/docs/adr/0013`), and `AdminRoute` (serves the exported Client UI at `LINQ_CLIENT_BASE_PATH`, path-traversal-checked, only on `LINQ_APP_HOST` when that is set) |
| `services/` | Business rules and Kysely queries as plain functions taking `db` first: `ApiKeyService` (mint, look up by token, CRUD), `LinkService` (links, tags, slug generation, `shortUrl`), `DomainService` (domains, the archive lock, `reconcileCaddy`), `RuleService` (pure rule matching plus rule storage), `RedirectService` (domain/target resolution, query merging), `VisitService` (fire-and-forget recording through an OpenTelemetry log pipeline whose exporter inserts into `visits`, `flushVisits`, raw-log filters; see `resources/docs/adr/0022`), `AnalyticsService` (rollup vs. raw-log reads), `QrCodeService`, `LlmsService` |
| `middleware/` | `authenticate.ts` (resolves the key, sets `c.var.principal`), `authorize.ts` (`authorize`), `rateLimit.ts` (per-key limit), `validate.ts` (zod validation in linq's error envelope, plus `idParam`), `requestLogger.ts` (the request/response log pair and the per-request async logging scope) |
| `libs/` | `db.ts` (the Postgres/PGlite `Db` boundary), `logger.ts` (pino, `reqLog()`, `span()`, secret scrubbing), `cache.ts` (the `Cache` port, memory and Redis backends, key builders, `readThrough`, `guardedCache`; see `resources/docs/adr/0009`), `caddy.ts` (Caddy admin API sync, `guardedCaddy`; see `resources/docs/adr/0012`), `linkMetadata.ts` (destination title/description/favicon with an SSRF guard), `userAgent.ts` (bot, preview-crawler, platform, OS and browser detection), `context.ts` (the Hono `Env` and `Principal` types) |
| `db/` | `migrations/` (ordered Kysely migrations), `types.generated.ts` (Kysely query types), `migrate.ts` (runs migrations in `LINQ_DB_SCHEMA` at boot) |
| `cli/` | `createKey.ts` (`bun run key:create`, mints a key without a restart through the same `createApiKey`), `migrate.ts`, `codegen.ts` |
| `types/` | Ambient declarations for untyped dependencies (`pino-roll`) |

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

One file per domain concept, all re-exported from `index.ts`: `links.ts`,
`domains.ts`, `rules.ts`, `qr-codes.ts`, `visits.ts`, `analytics.ts`,
`keys.ts`, `roles.ts` (the role ladder and `roleAtLeast`), `permissions.ts`
(`can` — the rules both `middleware/authorize.ts` on the server and the Client
UI's gating read), `primitives.ts` (shared zod primitives like slug/host
patterns), `errors.ts` (`ApiError`, thrown on the server and reconstructed
from a JSON body on the client). Nothing here imports from either app.

## `resources/`

| Path | What it is |
|------|------------|
| `sql/schema.sql` | The schema as `pg_dump --schema-only` output. Loads into any PostgreSQL, imports into ERD tools (pgAdmin, DBeaver, DataGrip, dbdiagram) |
| `openapi/linq.openapi.json` | The HTTP API as OpenAPI |
| `docs/architecture.md` | How the pieces fit together today, with flow diagrams for boot, auth and the redirect hot path |
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
