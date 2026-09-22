# Dockerfiles

Three shapes of the linq image — the canonical Dockerfiles this repo builds
from, whether that's a local `docker build`/`docker compose` or a CI workflow
publishing images:

| File | Contains | Runtime base |
| --- | --- | --- |
| `Dockerfile.client` | Client UI only, as a standalone static export | `oven/bun:1.4` |
| `Dockerfile.backend` | API and redirects only, no Client UI | `oven/bun:1.4` |
| `Dockerfile.full` | Both — the API and the Client UI at `/home`, one process | `oven/bun:1.4` |

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
docker build -f dockerfiles/Dockerfile.backend -t linq-backend .
docker build -f dockerfiles/Dockerfile.full     -t linq        .
```

`Dockerfile.client` needs no environment or Postgres — it's static files, and
the UI is pointed at a linq server at runtime, in the browser. `Dockerfile.backend`
and `Dockerfile.full` need `DATABASE_URL`, `LINQ_DEFAULT_DOMAIN`, etc. at
runtime — see `../docker-compose-examples/` for ready-made stacks around
either.

For the standalone client, use
`../docker-compose-examples/docker-compose.client.yml`. It reads
`LINQ_CLIENT_PORT` from your Compose env file to select the published host
port (default 3001), while the container listens internally on 3000.
This lets it share a host with other containers already publishing port 3000.
