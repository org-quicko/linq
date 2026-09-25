---
name: linq-dev
description: Start and use linq's local dev environment (API server + Client UI). Use when asked to run, start, launch, or manually try out this app, or when dev commands fail with a connection or CORS error.
---

# Running linq locally

Full walkthrough is in `README.md`; this is the condensed procedure plus the
gotchas that look like bugs but aren't.

## Prerequisites

- **Bun 1.4+** (`bun --version`).
- **PostgreSQL 15+, already running**, reachable at `DATABASE_URL`. linq never
  starts Postgres itself, locally or in Docker. No `DATABASE_URL` (or an
  unreachable one) makes the server exit immediately with
  `ERR_POSTGRES_CONNECTION_REFUSED` — that's the expected failure mode, not a
  bug to work around.

## One-time setup

```bash
bun install
psql -U postgres -c "CREATE DATABASE linq;"   # linq migrates the schema itself, but won't create the DB
cp .env.example .env                           # then set DATABASE_URL in .env
```

## Every time: two terminals

```bash
bun run dev         # terminal 1 — API + redirects on :3000. Migrations apply automatically at boot.
bun run dev:client  # terminal 2 — Client UI on :3001
```

`bun run start` is the same server without `--watch`.

## First boot only: capture the admin key

An instance with **no keys** mints an admin key and prints it once, to the
server terminal:

```
linq admin API key: linq_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Only its hash is stored — if you miss it, it cannot be read back. Mint more
without a restart with `bun run key:create --name <name> --preset <preset>`
(`viewer`, `editor` or `admin`; defaults to `admin`). There is no `--role`:
it was replaced by presets (`docs/adr/0017`).

## Pointing the Client UI at the server

Open `http://localhost:3001/home/` and fill in **Name**, **Server URL**
(`http://localhost:3000`), **API key**. The UI is a pure client: it holds a
list of `{name, url, key}` servers in the browser and never assumes the
instance that served it — nothing is baked in at build time (`docs/adr/0006`).
So switching or adding servers never needs a rebuild or restart.

**The dev Client UI on :3001 calls the API on :3000 cross-origin, with no
proxy in between** — same as a real deployment. If requests fail with an
opaque network error, suspect CORS/server config, not a missing proxy.

## Optional dependencies — don't reach for them by default

- **Redis**: only activates when `LINQ_REDIS_URL` is set. Once set, it must
  be reachable at boot or the server refuses to start (`docs/adr/0009`) — a
  Redis that dies *after* boot degrades to Postgres instead of failing
  requests. Not needed to run or test linq.
- **Caddy**: only activates when `LINQ_CADDY_ADMIN_URL` (and
  `LINQ_CADDY_UPSTREAM`) are set — see `docs/adr/0012`. Not needed to run or
  test linq.

Don't set either just to "run the app fully" — the default (in-process LRU
cache, no reverse-proxy sync) is the normal way to run this locally.
