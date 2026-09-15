# linq — Plan 1

> Milestones 1–7 below are complete. Work that follows them continues in
> [`Plan_2.md`](./Plan_2.md): tag filtering, logging, shadcn/ui and
> permission-aware controls.

## Context

linq is a self-hosted URL shortener and dynamic-link service on Hono + Bun + Next.js + PostgreSQL. It provides short links on configurable domains with random or custom slugs, query-param forwarding, ordered redirect rules (platform, query param, country), click analytics that separate human, bot and orphan traffic with coarse location, API-key authentication with four roles, an Admin UI, and later QR codes, Open Graph previews and link-in-bio pages. Postgres runs outside the linq image and is reached via `DATABASE_URL`.

## Glossary

- **Linq**: one short link. A Slug on a Domain, owned by a User. Kind `redirect` (has a Destination, may have Rules) or `tree` (serves a Tree page).
- **Slug**: the path segment after the host. Random (6 chars) or custom. Immutable. Reserved forever once used.
- **Domain**: a host that linqs live on. Has an optional Fallback URL.
- **Destination**: the long URL a redirect Linq sends people to. A Linq has one default Destination; a Rule supplies an alternate one.
- **Rule**: an ordered entry on a Linq. Alternate Destination plus one or more Conditions, all of which must hold. First matching Rule wins. What the brief called "Dynamic Links".
- **Condition**: `platform` (android | ios | desktop), `query_param` (key, optional value; no value means "present"), `country` (ISO-3166 alpha-2).
- **Click**: one request to a Domain. Flagged human or bot. Carries platform, country, region, referer, user agent, forwarded query, and the Destination chosen.
- **Orphan Click**: a Click on an active Domain that resolved to no active Linq: unknown slug, archived linq, or the root path.
- **Fallback URL**: where a Domain sends Orphan Clicks. Absent means 404.
- **Tree**: a Linq of kind `tree`. Serves a hosted page (title, description, image) listing Items, in the style of social-media profile link pages.
- **Item**: an ordered entry on a Tree: a label and a target Linq on the same Domain.
- **OG Preview**: per-Linq Open Graph title, description and image, served as HTML to bots so chat and social previews show them.
- **User**: an owner and principal. Has a Role and a status. Never logs in; acts only through Keys.
- **Key**: an API key belonging to a User. Shown once, stored hashed.
- **Role**: `viewer` < `author` < `editor` < `admin`. See permission matrix.
- **Archived**: the terminal status of a Linq or Domain. Nothing is hard-deleted.

## Settled decisions

**Scope.** Phase 1: Domains, Linqs, Rules, Clicks + stats, Users/Keys/Roles with bootstrap, REST API, Admin UI, one Docker image. Phase 2: QR endpoint, OG Preview, Tree, `groupBy=query:<param>` analytics. No CLI. No IP storage, no city.

**Topology.** One Hono process on one port serves: `/:slug` redirects on every host, `/api/*`, and the Next.js static export at `/admin/*`. Reserved slugs: `api`, `admin`, `health`, `robots.txt`, `favicon.ico`. TLS and DNS belong to the reverse proxy.

**Auth.** Key = `linq_` + `randomBytes(32).toString("base64url")`. Stored as SHA-256 hex; first 12 chars kept as display prefix. Accepted via `Authorization: Bearer <key>`, fallback `X-Api-Key`. Optional `expiresAt`. Revoke deletes the row. A disabled User's keys fail with 401. Bootstrap: on startup with zero users, create user `admin` (role admin) and one key, use `LINQ_INITIAL_API_KEY` if set else generate, print once to stdout.

**Permissions.** Only admins create users and keys. Nobody changes their own role.

| Action | viewer | author | editor | admin |
|---|---|---|---|---|
| Read linqs, domains, clicks, stats, tags | ✓ | ✓ | ✓ | ✓ |
| List users (`{id, name}` only) | ✓ | ✓ | ✓ | ✓ |
| Create linq | | ✓ | ✓ | ✓ |
| Update / archive own linq, edit its rules | | ✓ | ✓ | ✓ |
| Update / archive any linq, edit any rules | | | ✓ | ✓ |
| Transfer ownership | | own only | | any |
| Create / update / archive domain | | | | ✓ |
| Create / update / disable user, see role, email, keys | | | | ✓ |
| Create / revoke key (for any user) | | | | ✓ |

**Linq.** `slug` and `domainId` immutable. `status ∈ {active, archived}`; `DELETE` = archive; archived linqs hidden from lists unless `?status=archived|all`; archived → active is allowed. Archived slugs never redirect and never free up. Tags are `text[]`. Name optional, non-unique. Duplicate destinations allowed.

**Domain.** All domains are rows; there is no "default domain" in the model. `LINQ_DEFAULT_DOMAIN` seeds the first row when the table is empty. `status ∈ {active, archived}`; archiving is refused with 409 while any active linq exists; an archived domain returns untracked 404 for everything.

**Redirect.** Always `302` with `Cache-Control: no-store`. Query forwarding per linq, default on: incoming params merged over the destination's own params, incoming wins. `HEAD` is answered but not tracked. The click insert is not awaited.

**Clicks.** Bot flag from the `isbot` package. Platform from three regexes (`Android` → android, `iPhone|iPad|iPod` → ios, else desktop). Country + region from MaxMind GeoLite2-City mmdb when `LINQ_MAXMIND_LICENSE_KEY` is set, else empty. IP is used in-request for geo and never stored. Orphan Clicks share the table with `linqId NULL`.

**Stats.** SQL aggregates over `clicks` with proper indexes. No materialized views, no denormalised counters. Counting strategy to be revisited by the user later.

**API.** Base `/api/v1`; `/api/health` unauthenticated. Errors `{"error": {"code", "message", "details"}}` with codes `validation_failed` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404, `conflict` 409, `internal` 500. Lists `?limit=50&offset=0` (max 200) → `{"data", "total", "limit", "offset"}`. IDs UUIDv7 via `Bun.randomUUIDv7()`. camelCase JSON, ISO-8601 UTC timestamps.

**Admin UI.** Next.js 15 App Router, `output: "export"`, `basePath: "/admin"`, Tailwind + shadcn/ui. Login = paste key → `localStorage`. Every call sends `Authorization: Bearer`. `GET /api/v1/me` gates menus. Any 401 clears the key.

**Tooling.** Bun workspaces. Drizzle ORM on `drizzle-orm/bun-sql`; `drizzle-kit generate` for migrations, applied by the server at startup via `migrate()`. zod + `@hono/zod-validator`. Biome. `bun test`.

## Architecture

### Request flow: `GET https://{host}/{slug}?{query}`

1. Path is a reserved slug → handled by API / admin / robots routes. Otherwise continue.
2. Normalise host (lowercase, strip port). Load active Domain by host. None → `404`, not tracked.
3. Path `/` or slug not found or linq not active → **Orphan Click** (`linqId NULL`, `slugRequested`), then `302 fallbackUrl` or `404`.
4. Build match context: `platform` from UA, `query` parsed from the raw query string, `country` from geo (empty if unavailable).
5. Rules ordered by `position`; first rule whose every condition holds supplies the Destination. None → default Destination.
6. If `forwardQuery`, merge incoming params over the Destination's params.
7. Respond `302` + `Cache-Control: no-store`. Phase 2: if linq has OG fields and `isBot`, respond `200` HTML with `og:*` meta and `<meta http-equiv="refresh" content="0;url=...">` instead.
8. After responding, insert the Click without awaiting. Log on failure.

Phase 2 Tree: steps 5–7 replaced by rendering the Tree page (`200` HTML) listing active Items with links to `https://{host}/{itemSlug}`. Page view is a Click on the Tree linq.

### Auth flow: `/api/v1/*`

Middleware: extract token → `sha256hex` → `api_keys` join `users` → reject if missing, `expiresAt < now`, or `users.status = disabled` → set `c.var.principal = {userId, role, keyId}`. Route handlers call `assertRole(principal, ...)` / `assertOwnerOrRole(principal, linq, ...)` from one `permissions.ts`.

### Startup

`config` (zod, fail fast) → `migrate()` → bootstrap admin user+key if no users → seed domain if none and `LINQ_DEFAULT_DOMAIN` set → geo: if license key set and mmdb missing or older than 30 days, download `GeoLite2-City` tar.gz from the MaxMind permalink into `LINQ_DATA_DIR`, extract, open with the `maxmind` reader; re-check daily → `Bun.serve`.

## Data model (Drizzle, Postgres)

```
users        id uuid pk · name text · email text unique null · role enum(viewer,author,editor,admin)
             · status enum(active,disabled) · created_at · updated_at
api_keys     id uuid pk · user_id fk users · label text · key_hash text unique · prefix text(12)
             · expires_at timestamptz null · created_at
domains      id uuid pk · host text unique · fallback_url text null · status enum(active,archived)
             · created_at · updated_at
linqs        id uuid pk · domain_id fk domains · slug text · kind enum(redirect,tree) default redirect
             · destination text null (required when kind=redirect) · name text null · tags text[] default '{}'
             · forward_query bool default true · status enum(active,archived) · owner_id fk users
             · og_title/og_description/og_image text null (P2) · tree_title/tree_description/tree_image text null (P2)
             · tree_items jsonb null (P2: [{label, linqId}]) · created_at · updated_at
             UNIQUE (domain_id, slug) · INDEX (owner_id) · GIN (tags) · INDEX (status)
rules        id uuid pk · linq_id fk linqs on delete cascade · position int · destination text
             · conditions jsonb  -- [{type:'platform',value} | {type:'query_param',key,value?} | {type:'country',value}]
             UNIQUE (linq_id, position)
clicks       id uuid pk · linq_id fk linqs null · domain_id fk domains · slug_requested text
             · occurred_at timestamptz default now() · is_bot bool · platform enum(android,ios,desktop)
             · user_agent text null · referer text null · country char(2) null · region text null
             · destination text null · query jsonb null
             INDEX (linq_id, occurred_at DESC) · INDEX (domain_id, occurred_at DESC)
             · INDEX (occurred_at DESC) WHERE linq_id IS NULL
```

Notes: conditions live as validated jsonb on the rule rather than a separate conditions table. Tree items are jsonb validated at write time to reference active linqs on the same domain; archived targets are skipped at render.

## API surface

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | unauth `{status, version}` |
| GET | `/api/v1/me` | `{user:{id,name,role}, keyPrefix}` |
| GET/POST | `/api/v1/linqs` | filters `search, tags, domainId, ownerId, status, sort(createdAt\|clicks), order` |
| GET/PATCH/DELETE | `/api/v1/linqs/:id` | PATCH: destination, name, tags, forwardQuery, status, ownerId (rules below). DELETE = archive |
| GET/PUT | `/api/v1/linqs/:id/rules` | PUT replaces all; body is ordered array; server assigns position |
| GET | `/api/v1/linqs/:id/clicks` | `from, to, bot(true\|false\|any), limit, offset` |
| GET | `/api/v1/linqs/:id/stats` | `from, to, groupBy=day\|country\|region\|platform\|referer\|destination` → `[{key, human, bot}]` (P2 `query:<param>`) |
| GET | `/api/v1/stats` | same, all clicks; `orphan=true` for orphan slice |
| GET/POST | `/api/v1/domains` | admin for POST |
| GET/PATCH/DELETE | `/api/v1/domains/:id` | PATCH fallbackUrl, status. DELETE = archive, 409 if active linqs |
| GET | `/api/v1/domains/:id/stats` | |
| GET | `/api/v1/tags` | `[{tag, count}]` over active linqs |
| GET/POST | `/api/v1/users` | GET returns `{id,name}` for all roles, full record for admin; POST admin |
| GET/PATCH | `/api/v1/users/:id` | admin; PATCH name, email, role, status |
| GET/POST | `/api/v1/users/:id/keys` | admin; POST returns plaintext key once |
| DELETE | `/api/v1/keys/:id` | admin |
| GET | `/api/v1/linqs/:id/qr.svg` | P2, `?size=` |
| GET | `/robots.txt` | `Disallow: /api`, `Disallow: /admin` |
| GET | `/:slug`, `/` | redirect handler |

## Repo layout

```
package.json               bun workspaces: apps/*, packages/*
biome.json  tsconfig.base.json  Dockerfile  docker-compose.example.yml  .env.example
PLAN.md  CONTEXT.md  docs/adr/
packages/shared/src/       zod schemas + inferred types shared by server and admin (linq, rule, condition, user, key, domain, errors)
apps/server/src/
  main.ts                  boot sequence
  config.ts                zod env
  db/schema.ts  db/client.ts  db/migrations/   drizzle
  auth/keys.ts             generate, hash, prefix
  auth/middleware.ts       Bearer / X-Api-Key → principal
  auth/permissions.ts      assertRole, assertOwnerOrRole
  http/app.ts              mounts api, admin static, robots, redirect (order matters: reserved first)
  http/api/{me,linqs,rules,clicks,stats,domains,tags,users,keys,health}.ts
  http/redirect.ts         steps 1–8 above
  http/admin-static.ts     serveStatic apps/admin/out under /admin with index fallback
  clicks/record.ts  clicks/bot.ts  clicks/platform.ts  clicks/geo.ts
  rules/match.ts           pure: (rules, ctx) → destination | null
  slug.ts                  random base62, custom validation, reserved list
  bootstrap.ts             admin user + key, seed domain
apps/server/test/          unit + integration (TEST_DATABASE_URL)
apps/admin/                Next.js 15, output export, basePath /admin
  app/(login|linqs|linqs/[id]|linqs/new|domains|orphans|users)/
  lib/api.ts               fetch wrapper: Bearer from localStorage, 401 → logout
```

## Config

| Env | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | required | Postgres connection URL (external) |
| `LINQ_PORT` | `3000` | listen port |
| `LINQ_DEFAULT_DOMAIN` | | seeds first domain when table empty |
| `LINQ_INITIAL_API_KEY` | | admin key value at first boot; generated + printed if absent |
| `LINQ_MAXMIND_LICENSE_KEY` | | enables GeoLite2 download; absent → no location |
| `LINQ_DATA_DIR` | `./data` | mmdb storage |
| `LINQ_SLUG_LENGTH` | `6` | random slug length |
| `LINQ_TRUST_PROXY` | `true` | read client IP from `X-Forwarded-For` for geo |

`docker-compose.example.yml`: `postgres:17` service + `linq` service with `DATABASE_URL=postgres://...@postgres:5432/linq`. Postgres is never inside the linq image.

## Build order

Each milestone ends with its tests green.

1. **Scaffold**: workspaces, Biome, tsconfigs, `packages/shared` skeleton, server hello + `/api/health`, `config.ts`, Drizzle schema + first migration, Dockerfile (stage 1 `bun install` + `next build`; stage 2 `oven/bun` + server src + `apps/admin/out`), compose example.
2. **Auth**: users, api_keys, `keys.ts`, middleware, `bootstrap.ts`, `/me`, users + keys endpoints, `permissions.ts`. Tests: hash round-trip, 401 paths, disabled user, expired key, role matrix.
3. **Domains + Linqs**: CRUD, slug generation and validation, reserved list, tags endpoint, ownership transfer rule, archive semantics, 409 on domain archive. Tests: slug collisions, custom slug rejects, immutability, status filters.
4. **Redirect + Clicks**: `redirect.ts`, orphan handling, fallback URL, query forwarding, bot + platform, geo download and reader, fire-and-forget insert. Tests: each branch of the flow with real Postgres, HEAD not tracked.
5. **Rules**: `match.ts`, PUT rules, redirect integration. Tests: first-match-wins, AND semantics, empty-conditions rule never matches, missing geo fails country condition, query_param present vs equals.
6. **Stats**: clicks list, stats groupBy set, global and per-domain, orphan slice. Tests against seeded clicks.
7. **Admin UI**: login, linqs list, create/edit with rules editor, detail with charts + clicks table, domains, orphans, users & keys. Served from Hono at `/admin`.
8. **Ship**: image builds, boots against external Postgres, prints admin key, README quickstart.

**Phase 2** (separate milestones): QR endpoint (`qrcode` → SVG); OG fields + bot HTML response; Tree kind, items, page render, editor; `groupBy=query:<param>`.

## Verification

- `bun test` in `apps/server`: unit suites need no DB; integration suites need `TEST_DATABASE_URL` pointing at a scratch database, migrated in `beforeAll`, tables truncated between tests.
- End to end: `docker compose -f docker-compose.example.yml up`, read the printed admin key, then:
  ```
  curl -H "Authorization: Bearer $KEY" localhost:3000/api/v1/me
  curl -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
       -d '{"domainId":"...","destination":"https://example.com/?a=1","tags":["t"]}' localhost:3000/api/v1/linqs
  curl -i -H 'Host: <default domain>' 'localhost:3000/<slug>?b=2'      # expect 302 to example.com/?a=1&b=2
  curl -i -H 'Host: <default domain>' localhost:3000/nope              # expect fallback or 404, orphan click stored
  curl -H "Authorization: Bearer $KEY" 'localhost:3000/api/v1/linqs/<id>/stats?groupBy=platform'
  ```
- Admin UI: open `localhost:3000/admin`, paste key, create a linq with an android rule, confirm redirect with a mobile UA via `curl -A`.

## Deliberately left out

- IP storage, unique-visitor counts, city (ADR 0001).
- Hard delete (ADR 0002); user may revisit.
- Per-linq redirect status codes, cache lifetimes, validity windows, max-click limits, title auto-resolution, destination dedupe.
- Webhooks, pub/sub, analytics forwarding. Rate limiting. Runtime settings API. Click retention. Denormalised counters or rollups (revisit with the user).
- Self-service key management for non-admins. Per-domain access scoping.
- Restricting `/api` and `/admin` to one host (`LINQ_ADMIN_HOST`) — five-line middleware if wanted.

## ADRs (see `docs/adr/`)

**0001 – Clicks never store the client IP.** Hard to reverse (cannot back-fill), surprising to anyone expecting an address column, real trade-off: privacy and no anonymisation logic vs losing unique-visitor estimates. Decision: use IP in-request for geo only, persist country + region.

**0002 – Archive instead of delete; slugs are reserved forever.** Hard to reverse once clients rely on it, surprising vs the usual hard delete, trade-off: a used slug can never be reused (no hijacking a dead link, analytics history kept) vs slug namespace slowly consumed and no way to purge data. Decision: `status=archived` for linqs and domains, `DELETE` is an alias; hard delete deferred.
