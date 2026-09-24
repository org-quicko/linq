# Dockerfiles

The shapes of the linq image — the canonical Dockerfiles this repo builds
from, whether that's a local `docker build`/`docker compose` or a CI workflow
publishing images:

| File | Contains | Runtime base |
| --- | --- | --- |
| `Dockerfile.client` | Client UI only, as a standalone static export | `oven/bun:1.4` |
| `Dockerfile.server` | API and redirects only, no Client UI | `oven/bun:1.4` |
| `Dockerfile.full` | Both — the API and the Client UI at `/home` by default, one process | `oven/bun:1.4` |
| `Dockerfile.app-host` | Both, with the Client UI fixed at `/` on `LINQ_APP_HOST` | `oven/bun:1.4` |

`Dockerfile.client` runs `serve-static.ts` under plain Bun rather than
introducing nginx as a second base image. It mirrors
`../apps/server/src/http/admin-static.ts` — the handler the combined image
already uses to serve this same kind of export at `/home` — just mounted at
`/` instead: trailing-slash resolution, immutable caching for hashed
`_next/static` assets, the export's own `404.html`, and a path-traversal
guard. All tested behavior this repo already relies on, so there was nothing
to gain from nginx here.

All three build from the **repo root**, not this directory — the Client UI
imports `@linq/shared` as TypeScript over a workspace link and its tsconfig
reaches the repo root, so `bun install` needs the whole workspace present
even when only one app is being built:

```sh
docker build -f dockerfiles/Dockerfile.client  -t linq-client  .
docker build -f dockerfiles/Dockerfile.server  -t linq-server  .
docker build -f dockerfiles/Dockerfile.full     -t linq        .
```

`Dockerfile.full` accepts `LINQ_CLIENT_BASE_PATH` as a build argument. It feeds
the same value to the static frontend build and runtime server. The default is
`/home`; changing it requires rebuilding the image:

```sh
docker build --build-arg LINQ_CLIENT_BASE_PATH=/admin/example -f dockerfiles/Dockerfile.full -t linq .
```

The Dockerfile does not read `.env`; pass the argument explicitly. With Compose,
put the literal value under `services.linq.build.args` in the Compose file you
deploy, then rebuild.

`Dockerfile.app-host` is `Dockerfile.full` with the base path fixed at `/`, so the
UI sits at the root. The server accepts that only with `LINQ_APP_HOST` set at
runtime, so the UI answers on that one host and every other host keeps its short
links (`../docs/adr/0019`). CI publishes it as `linq-app-host`, next to `linq`,
`linq-server` and `linq-client`. Keep the two files in step; only the base path
differs:

```sh
docker build -f dockerfiles/Dockerfile.app-host -t linq-app-host .
```

`Dockerfile.full` with `--build-arg LINQ_CLIENT_BASE_PATH=/` builds the same
image.

`Dockerfile.client` needs no environment or Postgres — it's static files, and
the UI is pointed at a linq server at runtime, in the browser. `Dockerfile.server`
and `Dockerfile.full` need `DATABASE_URL`, `LINQ_DB_SCHEMA` (default `public`),
`LINQ_DEFAULT_DOMAIN`, etc. at
runtime — see `../docker-compose-examples/` for ready-made stacks around
either. Both server images default `LINQ_CACHE_SWEEP_INTERVAL` to 60 seconds;
override it at runtime with a value from 1 to 3600 seconds to tune how often the
in-memory cache reclaims expired entries.

For the standalone client, use
`../docker-compose-examples/10-client-only.yml`. It reads
`LINQ_CLIENT_PORT` from your Compose env file to select the published host
port (default 3001), while the container listens internally on 3000.
This lets it share a host with other containers already publishing port 3000.
