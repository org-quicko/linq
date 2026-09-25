<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logo/linq-wordmark-dark.svg">
    <img src="logo/linq-wordmark-light.svg" alt="linq" height="64">
  </picture>
</h1>

A self-hosted platform for short links.

## Features

- **URL Shortener**: branded short links on your own domains.
- **Dynamic Links**: rules that send each visitor to the right destination.
- **Custom domains with automatic HTTPS** through optional Caddy sync.
- **REST API** with scoped API keys (spec in `resources/openapi/`).
- **Link Tree** *(coming soon)*: one hosted page for all your links.

## Getting started

### Prerequisites

- [Bun](https://bun.sh) 1.4+
- [PostgreSQL](https://www.postgresql.org) 15+

linq never runs Postgres itself. Without it, the server exits with
`ERR_POSTGRES_CONNECTION_REFUSED`. Redis is optional, because the redirect cache
runs in the process by default.

### Installation

```bash
git clone https://github.com/org-quicko/linq.git
cd linq
bun install
psql -U postgres -c "CREATE DATABASE linq;"
cp .env.example .env   # then set DATABASE_URL to your Postgres credentials
```

linq applies its own migrations at boot, but it does not create the database.

### Usage

Start the API server and the Client UI in two terminals:

```bash
bun run dev         # API and redirects on :3000
bun run dev:client  # Client UI on :3001
```

The first time the server boots with **no API keys**, it prints an admin key
once:

```
  linq admin API key: linq_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Copy it now. Only its hash is stored. To mint another key without restarting,
run `bun run key:create --name ops --preset admin` (add `--expires <ISO date>` for
an expiry). If every key is ever revoked, the next restart mints a new admin key.

Open **http://localhost:3001/home/** and add a server:

| Field      | Value                         |
| ---------- | ----------------------------- |
| Name       | anything, e.g. `local`      |
| Server URL | `http://localhost:3000`     |
| API key    | the `linq_…` key from above |

The UI is a standalone client. It keeps a list of servers in the browser and
calls whichever one you pick, across origins and without a proxy. If requests
fail with an opaque network error, check the server's CORS setup first. See
`docs/adr/0006`.

| URL                            | What it is                               |
| ------------------------------ | ---------------------------------------- |
| http://localhost:3001/home/    | Client UI (development)                  |
| http://localhost:3000/home/    | Client UI (served from the built export) |
| http://localhost:3000/api/v1   | REST API                                 |
| http://localhost:3000/`slug` | A short link                             |

The root of a domain (`http://localhost:3000/`) is not the UI. It redirects to
that domain's fallback URL, or returns 404 if none is set.

## Configuration

Configuration is read from the repo-root `.env` (or `.env.local`). Only
`DATABASE_URL` is required. Every variable is documented in
[`.env.example`](.env.example). The ones you are most likely to change:

| Variable                           | Default                    | Description                                                                                         |
| ---------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                   | —                         | Postgres connection string.                                                                         |
| `LINQ_DB_SCHEMA`                 | `public`                 | The schema linq owns, created if missing. Set it when sharing a database.                           |
| `LINQ_PORT`                      | `3000`                   | Port for the API and redirect server.                                                               |
| `LINQ_CLIENT_PORT`               | `3001`                   | Port for the `dev:client` server.                                                                  |
| `LINQ_CLIENT_BASE_PATH`          | `/home`                  | Where a combined deployment mounts the UI.                                                          |
| `LINQ_APP_HOST`                  | —                         | Gives the UI a host of its own. See [UI on its own host](#ui-on-its-own-host).                        |
| `LINQ_DEFAULT_DOMAIN`            | `localhost:${LINQ_PORT}` | Seeds the first domain on an empty database only.                                                   |
| `LINQ_REDIS_URL`                 | —                         | Moves the redirect cache to Redis. Must be reachable at boot. See `docs/adr/0009`.                 |
| `LINQ_CACHE_TTL`                 | `300`                    | How many seconds a cached lookup lives.                                                             |
| `LINQ_FETCH_LINK_METADATA`       | `false`                  | Fetches a destination's title and icon. Enable only with egress rules that block private addresses. |
| `LINQ_API_RATE_LIMIT_PER_MINUTE` | `1000`                   | Per-key API rate limit.                                                                             |
| `LINQ_VISIT_MAX_PENDING`         | `1000`                   | Maximum queued analytics writes.                                                                    |

Logs are written to `./data/logs/linq.log` and rotated. In Docker this is the
`/data` volume.

## Deployment

Postgres is always external to linq, and so is Redis if you use it.

### Docker

The published image is `linq`, available as
[`labsatquicko/linq`](https://hub.docker.com/r/labsatquicko/linq) and
`ghcr.io/org-quicko/linq`.

| You want                   | Image                                                     | UI at                      | Required                                                     |
| -------------------------- | --------------------------------------------------------- | -------------------------- | ------------------------------------------------------------ |
| UI on its own domain       | `linq` (published)                                      | `/` on `LINQ_APP_HOST` | `DATABASE_URL`, `LINQ_DEFAULT_DOMAIN`, `LINQ_APP_HOST` |
| UI next to the short links | `Dockerfile` built with `LINQ_CLIENT_BASE_PATH=/home` | `/home` on every host    | `DATABASE_URL`, `LINQ_DEFAULT_DOMAIN`                    |
| API only                   | `Dockerfile.server`                                     | —                         | `DATABASE_URL`, `LINQ_DEFAULT_DOMAIN`                    |
| UI only                    | `Dockerfile.client`                                     | `/`                      | —                                                           |

`docker/examples/docker-compose/` has a Compose stack for each combination:
bundled or external Postgres, with or without Redis, with or without Caddy, and
split client/server setups:

```sh
docker compose -f docker/examples/docker-compose/01-bundled-postgres.yml up --build -d
```

See [`docker/examples/README.md`](docker/examples/README.md) for details on
every stack.

> [!IMPORTANT]
> The UI base path is fixed when the image is built. After changing
> `LINQ_CLIENT_BASE_PATH`, rebuild the image. Changing only the container's
> environment leaves the UI and the server using different paths.

### UI on its own host

```dotenv
LINQ_APP_HOST=linq.example.com       # UI at /, API at /api/*
LINQ_DEFAULT_DOMAIN=link.example.com # short links at link.example.com/<slug>
```

The UI answers only on the app host. Every other host serves short links, and
`/api/*` answers on all hosts. The app host must differ from every registered
domain. Behind a reverse proxy, route both hosts to the same port and preserve
the `Host` header. See `docs/adr/0019`.

### Static hosting

`bun run build:client:standalone` writes `apps/client/out-standalone`, which you
can host on Vercel, Netlify, S3, nginx or similar. No API URL is compiled in, so
one deployment can manage any number of linq instances. Build it from a full
checkout, and make sure the host serves `x/index.html` for `/x/`.

### Automatic HTTPS

Use a Caddy Compose example (3, 4, 7 or 8). When `LINQ_CADDY_ADMIN_URL` is set,
linq pushes every domain change to Caddy. Once a domain's DNS points at the
host, adding the domain in linq is enough to serve it over HTTPS. See
`docs/adr/0012`.

The Caddy examples do not publish linq's port 3000 to the host. Caddy is the only
public entry point, so API keys never travel over a plaintext bypass.

## Development

```bash
bun run test                     # server and client test suites
bun run typecheck                # tsc -b --force
bun run lint                     # biome check .
bun run format                   # biome check --write .
bun run build:client             # UI export served by linq
bun run build:client:standalone  # UI export for a static host
bun run db:migrate               # apply pending migrations
bun run db:codegen               # regenerate Kysely types
```

Contributors and coding agents should read [`AGENTS.md`](AGENTS.md) first.

## Documentation

- [`CONTEXT.md`](CONTEXT.md): the domain vocabulary. Read it before the code.
- [`docs/architecture.md`](docs/architecture.md): how the pieces fit together.
- [`docs/repo-map.md`](docs/repo-map.md): where everything lives.
- [`docs/adr/`](docs/adr/): architecture decision records.
- [`resources/openapi/linq.openapi.json`](resources/openapi/linq.openapi.json): the REST API spec.
