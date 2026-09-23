# AGENTS.md

Context for any agent working in this repo. Full user-facing setup and
deployment docs are in `README.md` — read that before touching
`apps/server`, `dockerfiles/`, or `docker-compose-examples/`. This file only
covers what isn't obvious from the code.

## Running it

- `bun run dev` / `bun run start` need Postgres reachable at `DATABASE_URL`,
  or the process exits with `ERR_POSTGRES_CONNECTION_REFUSED`. Migrations
  apply automatically at boot — there is no separate migrate command.
- `bun run test` needs nothing running. It uses an in-memory Postgres
  (PGlite, see `apps/server/test/helpers/db.ts`) per suite, never the real
  database or `DATABASE_URL`.
- After editing `apps/server/src/db/schema.ts`, run `bun run db:generate` to
  produce the migration. Don't hand-edit generated migration SQL.

## Redis and Caddy are optional, and fail loud

- Redis only activates when `LINQ_REDIS_URL` is set. Once set, Redis must be
  reachable at boot or the server refuses to start — that's intentional
  (`docs/adr/0009`), not a bug to smooth over. A Redis that dies *after* boot
  degrades to Postgres instead.
- Caddy sync only activates when `LINQ_CADDY_ADMIN_URL` is set (needs
  `LINQ_CADDY_UPSTREAM` too). See `docs/adr/0012`.
- Neither is required to run or test linq. Don't make either a hard
  dependency.

## Docs conventions

- `CONTEXT.md` is glossary only: terms, no implementation detail.

## Where things live

- `README.md` — local setup, Docker, Redis/Caddy, deploying the Client UI.
- `CONTEXT.md` — domain vocabulary.
- `docs/architecture.md` — how the pieces fit together today.
- `docs/repo-map.md` — where everything lives, in more detail than this list.
- `docs/adr/` — decisions that are hard to reverse, and why.
- `.agents/skills/` — step-by-step procedures for this repo (dev environment,
  DB migrations, ADRs), for any agent.
