# AGENTS.md

Context for any agent working in this repo. Full user-facing setup and
deployment docs are in `README.md` — read that before touching
`apps/server` or `docker/`. This file only
covers what isn't obvious from the code.

## Running it

- `bun run dev` / `bun run start` need Postgres reachable at `DATABASE_URL`,
  or the process exits with `ERR_POSTGRES_CONNECTION_REFUSED`. Migrations
  apply automatically at boot; `bun run db:migrate` runs the same runner
  explicitly.
- `bun run test` needs nothing running. It uses an in-memory Postgres
  (PGlite, see `apps/server/test/helpers/db.ts`) per suite, never the real
  database or `DATABASE_URL`.
- Database DDL lives in ordered, frozen Kysely migrations under
  `apps/server/src/infra/db/migrations/` (`0001_initial.ts` is the whole baseline
  schema). Add a new `NNNN_<name>.ts` there, then run `bun run db:codegen`
  against a migrated PostgreSQL database to refresh query types.

## Redis is required, Caddy is optional, and both fail loud

- Redis is the only cache since 2.0 (`resources/docs/adr/0024`). `LINQ_REDIS_URL`
  is required and must be reachable at boot, or the server refuses to start;
  that's intentional, not a bug to smooth over. A Redis that dies *after* boot
  degrades to Postgres instead. For local runs: `docker run -d -p 6379:6379 redis:8`.
- Writes keep the cache fresh by writing through, with versioned writes
  (`writeThrough` and the Lua script in `infra/cache.ts`), never by deleting,
  except purge and `/llms.txt`. A new write site must do the same; see the ADR.
- Caddy sync only activates when `LINQ_CADDY_ADMIN_URL` is set (needs
  `LINQ_CADDY_UPSTREAM` too). See `resources/docs/adr/0012`. Don't make it a
  hard dependency.
- `bun run test` needs neither. Suites use the in-process fake in
  `test/helpers/cache.ts`; `test/redis-cache.test.ts` runs only when
  `TEST_REDIS_URL` is set.

## Docs conventions

- `GLOSSARY.md` is glossary only: terms, no implementation detail.

## Where things live

- `README.md` — local setup, Docker, Redis/Caddy, deploying the Client UI.
- `GLOSSARY.md` — domain vocabulary.
- `resources/docs/architecture.md` — how the pieces fit together today.
- `resources/docs/repo-map.md` — where everything lives, in more detail than this list.
- `resources/docs/adr/` — decisions that are hard to reverse, and why.
- `.agents/skills/` — step-by-step procedures for this repo (dev environment,
  DB migrations, ADRs), for any agent.
- `docs` - documentation for linq
