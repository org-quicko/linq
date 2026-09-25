# Docker examples

The published image, `linq`, is built from `../dockerfiles/Dockerfile`.
Everything in this folder is an example, and none of it is published:

- `docker-compose/`: one Compose stack per deployment shape.
- `dockerfiles/`: the other image shapes those stacks build from, and the
  Caddy config they mount.

## Compose files

Every combination of linq's optional pieces — Postgres bundled vs. external,
Redis on/off (docs/adr/0009), Caddy on/off (docs/adr/0012). Pick the file that
matches your setup, configure the repo-root `.env`, then
`docker compose -f <file> up`. Each `linq` service loads that file with
`env_file`, so it is its runtime configuration as well as Compose's source for
port, build-argument, and bundled-Postgres substitutions.

All `build:`, volume-mount, and `env_file` paths are resolved relative to the
Compose file's directory (`../../..` reaches the repo root), not your shell's
directory. Run from `docker-compose/`, or use
`-f docker/examples/docker-compose/<file>` from the repo root. If you
copy a file elsewhere, change `../../../.env` to the `.env` beside the copied
file and fix the other relative paths first.

Set `LINQ_PORT` in the repo-root `.env` to change the published port from
3000. Run from the repo root, or pass `--env-file ../../../.env` when running
from `docker-compose/` so Compose can interpolate that value. The container and Caddy
upstream stay on port 3000. `LINQ_DATA_DIR` is always `/data` in the container,
so the Compose volume remains the persistent log location.
`LINQ_DEFAULT_DOMAIN` can also be set in that env file; when absent, it
defaults to `localhost:<LINQ_PORT>`. For an existing database, change the
domain through the UI as well: the default domain only seeds an empty database.
`LINQ_DB_SCHEMA` selects the PostgreSQL schema linq owns and defaults to
`public`; set it when sharing a database with another application. The server
creates it during migration when it does not already exist.
The examples without Redis also pass through `LINQ_CACHE_SWEEP_INTERVAL`,
accepting 1 to 3600 seconds and defaulting to 60, for the in-process cache.

| # | File | Postgres | Redis | Caddy |
| --- | --- | --- | --- | --- |
| 1 | `01-bundled-postgres.yml` | bundled | – | – |
| 2 | `02-bundled-postgres-redis.yml` | bundled | yes | – |
| 3 | `03-bundled-postgres-caddy.yml` | bundled | – | yes |
| 4 | `04-bundled-postgres-full.yml` | bundled | yes | yes |
| 5 | `05-external-postgres.yml` | external | – | – |
| 6 | `06-external-postgres-redis.yml` | external | yes | – |
| 7 | `07-external-postgres-caddy.yml` | external | – | yes |
| 8 | `08-external-postgres-full.yml` | external | yes | yes |

Three more cover other deployment shapes: `09-server-only.yml` and
`10-client-only.yml` split the API and the Client UI into separate containers,
and `11-app-host.yml` puts both on one host of their own. They're described
below.

All eight of the above build from `../dockerfiles/Dockerfile` — the
combined image, API plus Client UI, which these files build at `/home`. The UI path is a
build-time option. Their build argument is wired to
`LINQ_CLIENT_BASE_PATH` in `.env`; change that value and run
`docker compose ... up --build`. It is baked into the frontend, so restarting
without rebuilding is not enough.
`dockerfiles/` also has
`Dockerfile.server` (API only) and `Dockerfile.client` (Client UI only, as a
standalone export); the two files below (9 and 10) build from those instead,
for a split deployment across separate containers and ports.

`09-server-only.yml` is not a stack on its own — it's a small override on
`01-bundled-postgres.yml` that swaps in `Dockerfile.server`, so there's no
Client UI at all, not even at `/home`. Layer it on top with a second `-f`,
and pair the result with `10-client-only.yml`, which runs the standalone
Client UI at `/`, with no API or database of its own. The client's host
port is `${LINQ_CLIENT_PORT:-3001}`; the server's is `${LINQ_PORT:-3000}`
as usual; both containers keep listening on 3000 internally. From the repo
root:

```sh
docker compose --env-file .env -f docker/examples/docker-compose/01-bundled-postgres.yml -f docker/examples/docker-compose/09-server-only.yml -f docker/examples/docker-compose/10-client-only.yml up --build -d
```

For example, `LINQ_PORT=8080` and `LINQ_CLIENT_PORT=8081` publish the API on
8080 and the standalone UI on 8081. Open `http://localhost:8081/`, add a
server pointing at `http://localhost:8080`, and the UI talks to it across
origins — no `/home` involved on either side. Choose distinct, unused host
ports.

Pairing `10-client-only.yml` with one of the eight combined-image
files above works too, but is redundant: the combined image already serves a
UI at `/home` on `LINQ_PORT`, so the separate client only makes sense there
if you specifically want the Client UI at `/` as well.

## The UI and API on their own host

One process can also serve the Client UI at `/` and the API at `/api/*` on one
host, with short links on the others (`docs/adr/0019`). Set `LINQ_APP_HOST` to
that host in `.env`; it must differ from `LINQ_DEFAULT_DOMAIN` and from every
domain you register. linq tells the hosts apart by the `Host` header, so point
both at the same container.

`11-app-host.yml` does this with the published `linq` image
(`../dockerfiles/Dockerfile` with its default base path, `/`)
against an external Postgres. It builds nothing, and it refuses to start
without `LINQ_APP_HOST` and `LINQ_DEFAULT_DOMAIN`. `LINQ_IMAGE_REPOSITORY` and `LINQ_IMAGE_VERSION` pick
the image, defaulting to `ghcr.io/org-quicko/linq:latest`.

Any of the eight build-from-source files above works the same way: set
`LINQ_CLIENT_BASE_PATH=/` and `LINQ_APP_HOST` in `.env`, then
`docker compose ... up --build`. With a Caddy example (3, 4, 7, 8), linq pushes
a route for `LINQ_APP_HOST` at boot next to the domain routes, so the app host
gets its certificate like any domain does. Its DNS still has to point at this
host.

Archive any existing domain whose host equals `LINQ_APP_HOST` first. The UI
claims every path on that host, so its links would stop resolving.

"External" Postgres means no `postgres` service in the file — set
`DATABASE_URL` in `.env` to point at your own instance instead. Set
`LINQ_DB_SCHEMA` there as well when its tables are not in `public`. Both are
loaded directly into the `linq` container through `env_file`.

For a local check from the repo root:

```sh
docker compose -f docker/examples/docker-compose/01-bundled-postgres.yml up --build -d
docker compose -f docker/examples/docker-compose/01-bundled-postgres.yml logs linq
curl http://localhost:3000/api/health
```

Open `http://localhost:3000/home/` for the UI and use the admin key printed
in the logs. Substitute any other example filename to try that stack. Stop
one before starting another: they publish the same host ports and share a
default Compose project name. Use `down` with the same `-f` argument to stop
it; add `--volumes` only when you intend to delete its stored data.

For external Postgres on the Docker Desktop host, use
`host.docker.internal` in `.env`'s `DATABASE_URL`, not `localhost` (which
refers to the linq container).

Caddy examples publish only ports 80 and 443; linq stays reachable to Caddy at
`linq:3000` over the Compose network. With the
default localhost domain, `https://localhost/api/health` uses Caddy's local
CA; trust that CA or use `curl -k` for this local smoke check. Public
certificate issuance still requires a real domain, public DNS, and inbound
ports 80/443, and cannot be validated by a localhost-only test.

## Dockerfiles

| File | Contains |
| --- | --- |
| `../dockerfiles/Dockerfile` | The published `linq` image: API and Client UI in one process, the UI at `LINQ_CLIENT_BASE_PATH` (`/` by default, on `LINQ_APP_HOST`) |
| `dockerfiles/Dockerfile.server` | API and redirects only, no Client UI |
| `dockerfiles/Dockerfile.client` | Client UI only, as a standalone static export |

All run on `oven/bun:1.4` and build from the **repo root**, not this
directory — the Client UI imports `@linq/shared` as TypeScript over a
workspace link and its tsconfig reaches the repo root, so `bun install` needs
the whole workspace present even when only one app is being built:

```sh
docker build -f docker/examples/dockerfiles/Dockerfile.client  -t linq-client  .
docker build -f docker/examples/dockerfiles/Dockerfile.server  -t linq-server  .
docker build -f docker/dockerfiles/Dockerfile                  -t linq         .
```

`../dockerfiles/Dockerfile` accepts `LINQ_CLIENT_BASE_PATH` as a build argument.
It feeds the same value to the static frontend build and runtime server. The
default is `/`; changing it requires rebuilding the image:

```sh
docker build --build-arg LINQ_CLIENT_BASE_PATH=/admin/example -f docker/dockerfiles/Dockerfile -t linq .
```

The Dockerfile does not read `.env`; pass the argument explicitly. With Compose,
put the literal value under `services.linq.build.args` in the Compose file you
deploy, then rebuild.

With the default `/`, the server starts only with `LINQ_APP_HOST` set at
runtime, so the UI answers on that one host and every other host keeps its
short links (`docs/adr/0019`).

`Dockerfile.client` runs `serve-static.ts` under plain Bun rather than
introducing nginx as a second base image. It mirrors
`apps/server/src/http/admin-static.ts` — the handler the combined image
already uses to serve this same kind of export at `/home` — just mounted at
`/` instead: trailing-slash resolution, immutable caching for hashed
`_next/static` assets, the export's own `404.html`, and a path-traversal
guard. It needs no environment or Postgres — the UI is pointed at a linq
server at runtime, in the browser. The server images need `DATABASE_URL`,
`LINQ_DB_SCHEMA` (default `public`), `LINQ_DEFAULT_DOMAIN`, etc. at runtime,
and default `LINQ_CACHE_SWEEP_INTERVAL` to 60 seconds (1 to 3600).

`dockerfiles/caddy/caddy.json` is the empty skeleton Caddy boots from in the Caddy
examples (3, 4, 7, 8); see `docs/adr/0012`.

See the root `README.md` (Deploying section) for what each piece does.
