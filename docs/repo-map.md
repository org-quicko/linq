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
├─ resources/     generated artifacts kept in the repo: DBML and the OpenAPI spec
├─ docs/
│  ├─ adr/        decisions that are hard to reverse, and why
│  └─ plans/      numbered design plans each milestone was built from
├─ docker-compose-examples/, dockerfiles/, caddy/   deployment shapes
└─ .claude/, .agents/   skills: step-by-step procedures for agents working here
```

One Bun workspace (`workspaces: ["apps/*", "packages/*"]`), one `bun.lock`.
`tsconfig.json` covers `packages/shared` and `apps/server`; `apps/client` is
a separate Next.js project with its own config. `bun run typecheck` runs
`tsc -b --force` across both.

## Root files

| Path | What it is |
|------|------------|
| `package.json` | Workspace root. Delegates every script (`dev`, `test`, `db:generate`, …) to the member that owns it via `bun --filter` |
| `AGENTS.md` | What isn't obvious from the code: running it, Redis/Caddy's fail-loud behaviour, docs conventions |
| `CLAUDE.md` | Points Claude at `AGENTS.md` and `.claude/skills/` |
| `CONTEXT.md` | The domain glossary — terms only, no implementation |
| `README.md` | Local setup, Docker, deploying the Client UI |
| `biome.json` | Lint/format config (`bun run lint` / `format`) |
| `.env.example` | Every environment variable, with a comment; `config.ts` is the schema that actually enforces them |

## `apps/server/src/`

| Path | What it holds |
|------|----------------|
| `main.ts` | Boot sequence: config → logger → db → migrations → bootstrap → cache/Caddy/metadata → app → listen. Owns shutdown draining |
| `bootstrap.ts` | First-boot admin key mint and default-domain seed, each gated on its table being empty |
| `config.ts` | The zod schema for every `LINQ_*`/`DATABASE_URL` env var; exits the process on a bad one |
| `cache.ts` | The `Cache` port, its memory (LRU) and Redis backends, and `guarded()`, which makes a cache failure act like a miss instead of an error. See `docs/adr/0009` |
| `caddy.ts` | Syncs the `domains` table to Caddy's admin API for automatic HTTPS per custom domain, and the boot-time reconcile after Caddy's own restart. See `docs/adr/0012` |
| `link-metadata.ts` | Fetches a destination's title/description/favicon in the background, with an SSRF guard against private/loopback IPs |
| `log.ts` | The pino logger, per-request child logger via `AsyncLocalStorage`, the `span()` timing helper, and secret scrubbing |
| `slug.ts` | `randomSlug` — uniform base62 generation for a link's slug |
| `auth/` | `middleware.ts` (the `authenticate` Hono middleware), `keys.ts` (hash/prefix a key), `mint.ts` (`createApiKey`, shared by the HTTP route and the CLI), `permissions.ts` (the throwing `assert*` wrappers over `@linq/shared`'s `can`) |
| `db/` | `schema.ts` (Drizzle tables — see architecture.md's data model), `client.ts` (`createDb`, the driver-agnostic `Db` type the test suite substitutes PGlite for), `migrate.ts` (runs migrations at boot) |
| `http/app.ts` | `createApp` — mounts every route, in the order that keeps the redirect catch-all from shadowing anything reserved |
| `http/redirect.ts` | The redirect handler: domain/link/rule resolution, the cache-through helper, query merging, and the link-preview OG page |
| `http/admin-static.ts` | Serves the exported Client UI at `/home`, path-traversal-checked |
| `http/llms.ts` | `GET /llms.txt` — the per-domain catalogue of opted-in links, unauthenticated. See `docs/adr/0013` |
| `http/env.ts` | The Hono `Env` type — what `c.var` and `c.get`/`c.set` carry (db, config, cache, caddy, metadata, principal) |
| `http/validate.ts` | The zod-body/query/param validation middleware every route uses |
| `http/api/` | One file per resource: `analytics.ts`, `domains.ts`, `keys.ts`, `links.ts` (+ `tagRoutes`), `me.ts`, `qr-codes.ts`, `rules.ts`, `visits.ts` — each a Hono sub-app mounted under `/api/v1` in `app.ts` |
| `rules/` | `match.ts` (pure condition evaluation, no I/O), `store.ts` (loads a link's rules in position order) |
| `visits/` | `record.ts` (fire-and-forget insert plus `flushVisits` for shutdown), `bot.ts` (bot and link-preview-crawler detection), `platform.ts` (platform/OS/browser parsing from the user agent) |
| `cli/create-key.ts` | `bun run key:create` — mints a key without a restart, same path as the HTTP route |

## `apps/client/`

| Path | What it holds |
|------|----------------|
| `app/` | Next.js App Router pages, one directory per route: `overview/`, `links/` (+ `new/`, `detail/`, `trash/`), `domains/` (+ `trash/`), `orphans/`, `visits/`, `analytics/`, `archives/`, `settings/` (+ `domains/`, `keys/`), `dev/components/` (a component playground) |
| `components/` | Feature components (`link-form-dialog.tsx`, `rules-editor.tsx`, `qr-form-dialog.tsx`, `server-switcher.tsx`, `server-form.tsx`, …); `patterns/` for reusable page-building blocks (`row-card`, `stat-card`, `page-header`, `empty-state`, `domain-picker`, …); `ui/` for the shadcn-derived primitives |
| `lib/api.ts` | The one fetch call site — attaches the active server's key, normalizes a 401 into "disconnect and redirect" |
| `lib/servers.ts` | The saved-servers `localStorage` model: list, active, probe (health + `/me` check before saving), legacy single-key migration. See `docs/adr/0006` |
| `lib/store/` | Redux Toolkit: `index.ts` wires the store, `api.ts` the RTK Query base, one file per resource (`domains.ts`, `links.ts`, `keys.ts`, `qr-codes.ts`, `stats.ts`) |
| `lib/hooks.ts`, `lib/qr.ts`, `lib/base-path.ts`, `lib/utils.ts` | Shared client-only helpers — hooks, QR rendering, the `/home` base-path prefixer for `next/link`-bypassing redirects, misc |
| `test/` | Client-side unit tests, mirroring `lib/` |

## `packages/shared/src/`

One file per domain concept, all re-exported from `index.ts`: `links.ts`,
`domains.ts`, `rules.ts`, `qr-codes.ts`, `visits.ts`, `analytics.ts`,
`keys.ts`, `roles.ts` (the role ladder and `roleAtLeast`), `permissions.ts`
(`can` — the rules both `auth/permissions.ts` on the server and the Client
UI's gating read), `primitives.ts` (shared zod primitives like slug/host
patterns), `errors.ts` (`ApiError`, thrown on the server and reconstructed
from a JSON body on the client). Nothing here imports from either app.

## `resources/`

| Path | What it is |
|------|------------|
| `dbml/linq.dbml` | The schema as DBML, for diagramming |
| `openapi/linq.openapi.json` | The HTTP API as OpenAPI |

## `docs/`

| Path | What it is |
|------|------------|
| `architecture.md` | How the pieces fit together today |
| `repo-map.md` | This file |
| `adr/000N-*.md` | One decision per file, numbered sequentially |

## `docs/plans/`

`Plan_N.md`, one per milestone of work, numbered sequentially — written and
reviewed before the code that implements it, per `.claude/skills/linq-plan`.

## Deployment

| Path | What it is |
|------|------------|
| `dockerfiles/` | `Dockerfile.full` (server + built Client UI in one image), `Dockerfile.backend` (server only, `/home` 404s), `Dockerfile.client` (standalone client build) |
| `docker-compose-examples/` | One compose file per deployment shape — bundled or external Postgres, with or without Redis/Caddy, client served together or standalone |
| `caddy/` | The Caddy config template used by the `*.with-caddy.yml`/`*.full.yml` compose files. See `docs/adr/0012` |

## Agent tooling

`.agents/skills/` and `.claude/skills/` hold the same set, mirrored for both
tools: `linq-dev` (start the dev environment), `linq-db-migration` (edit
`db/schema.ts` and generate the matching migration), `linq-adr` (write a new
ADR), `linq-plan` (write a new plan before implementing).
