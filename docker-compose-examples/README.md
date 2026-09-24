# Docker Compose examples

Every combination of linq's optional pieces — Postgres bundled vs. external,
Redis on/off (docs/adr/0009), Caddy on/off (docs/adr/0012). Pick the file that
matches your setup, configure the repo-root `.env`, then
`docker compose -f <file> up`. Each `linq` service loads that file with
`env_file`, so it is its runtime configuration as well as Compose's source for
port, build-argument, and bundled-Postgres substitutions.

All `build:`, volume-mount, and `env_file` paths are resolved relative to the
Compose file's directory (`..` reaches the repo root), not your shell's
directory. Run from here, or use `-f docker-compose-examples/<file>` from the
repo root. If you copy a file elsewhere, change `../.env` to the `.env` beside
the copied file and fix the other relative paths first.

Set `LINQ_PORT` in the repo-root `.env` to change the published port from
3000. Run from the repo root, or pass `--env-file ../.env` when running from
this directory so Compose can interpolate that value. The container and Caddy
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

All eight of the above build from `../dockerfiles/Dockerfile.full` — the
combined image, API plus Client UI at `/home` by default. The UI path is a
build-time option. Their build argument is wired to
`LINQ_CLIENT_BASE_PATH` in `.env`; change that value and run
`docker compose ... up --build`. It is baked into the frontend, so restarting
without rebuilding is not enough.
`../dockerfiles/` also has
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
docker compose --env-file .env -f docker-compose-examples/01-bundled-postgres.yml -f docker-compose-examples/09-server-only.yml -f docker-compose-examples/10-client-only.yml up --build -d
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

"External" Postgres means no `postgres` service in the file — set
`DATABASE_URL` in `.env` to point at your own instance instead. Set
`LINQ_DB_SCHEMA` there as well when its tables are not in `public`. Both are
loaded directly into the `linq` container through `env_file`.

For a local check from the repo root:

```sh
docker compose -f docker-compose-examples/01-bundled-postgres.yml up --build -d
docker compose -f docker-compose-examples/01-bundled-postgres.yml logs linq
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

See `../README.md` (Docker section) for what each piece does, and
`../dockerfiles/` for the Dockerfiles these all build from.
