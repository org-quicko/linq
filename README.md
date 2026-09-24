# linq

Self-hosted SaaS including URL Shortener, Dynamic Link and Link Tree Creator

## Running it locally

### What you need

- **Bun 1.4+** — `bun --version`. If the command is not found, it installs to
  `~/.bun/bin` and that directory has to be on your `PATH`.
- **PostgreSQL 15+**, running and reachable on `localhost:5432`. linq never runs
  Postgres itself, locally or in Docker — start it before the steps below, or the
  server exits on boot with `ERR_POSTGRES_CONNECTION_REFUSED`.

That is the whole list. The redirect cache runs inside the linq process by
default, on an in-memory LRU, so nothing else has to be running.
Setting `LINQ_REDIS_URL` moves it to Redis instead — a shared store, which one
instance's invalidations reach all of. `docs/adr/0009` describes what the two
differ in; neither is the recommended one. A configured Redis has to be
reachable or the server will not start, though one that goes down *later*
degrades to Postgres rather than failing requests.

### 1. Install dependencies

```bash
bun install
```

### 2. Create the database

linq applies its own migrations at boot, but it will not create the database.

```bash
psql -U postgres -c "CREATE DATABASE linq;"
```

`psql` ships with Postgres but is not always on `PATH` — on Windows it lives in
the install's `bin` directory. Any client will do; so will your existing tooling.

### 3. Configure

```bash
cp .env.example .env
```

Then edit `.env` and set `DATABASE_URL` to your own Postgres credentials. That
is the only required value; everything else has a working default. `LINQ_DB_SCHEMA`
selects the schema linq owns and defaults to `public`; set it when sharing a
database with another application. linq creates the selected schema if needed.
The defaults
put the server on port 3000, seed `localhost:3000` as the first domain, and
cache redirect lookups in the process for five minutes.

Both local ports are configurable in the repo-root `.env` (or `.env.local`):

```dotenv
LINQ_PORT=4000
LINQ_CLIENT_PORT=4001
LINQ_CLIENT_BASE_PATH=/home
LINQ_DEFAULT_DOMAIN=localhost:${LINQ_PORT}
```

`LINQ_PORT` controls the API/redirect server for `dev` and `start`;
`LINQ_CLIENT_PORT` controls `dev:client`. They default to 3000 and 3001.
`LINQ_CLIENT_BASE_PATH` controls where a combined deployment mounts the UI and
defaults to `/home`. `LINQ_APP_HOST` is unset by default; set it only to give the
UI a host of its own, see [The UI and API on their own host](#the-ui-and-api-on-their-own-host).
`LINQ_CACHE_SWEEP_INTERVAL` controls how often the in-process cache physically
reclaims expired entries, accepts 1 to 3600 seconds, and defaults to 60; it does
not change when an entry expires, which remains controlled by `LINQ_CACHE_TTL`.
`LINQ_FETCH_LINK_METADATA` defaults to `false`: enabling it lets linq fetch a
destination's title, description and icon. Enable it only with outbound network
rules that block private/internal addresses. `LINQ_API_RATE_LIMIT_PER_MINUTE`
and `LINQ_VISIT_MAX_PENDING` bound per-key API traffic and queued analytics work.
Restart the relevant process after changing a port, and use that port in
your browser and the UI's saved Server URL. `LINQ_DEFAULT_DOMAIN` only seeds
an empty database; update an existing domain through the UI if its port changes.

### 4. Start the API server

```bash
bun run dev
```

Leave it running; it serves the API the Client UI talks to.

On an instance that has **no keys** it mints an admin key and prints it, once:

```
  linq admin API key: linq_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  Store it now; it is not recoverable.
  Create more with: bun run key:create --name <name> --preset <preset>
```

Copy it now — only its hash is stored, so it cannot be read back. Every later
start prints nothing, which is what you will see on a database you have used
before.

The guard is "no keys", not "never booted": if every key is ever revoked, the
next restart mints a fresh one rather than leaving the instance unreachable.

<details>
<summary>Another key, without a restart</summary>

```bash
bun run key:create --name ops --preset admin
```

`--preset` defaults to `admin`; `--expires <ISO date>` sets an expiry. This is the
same mint the API and the Keys page use, and it is the way in when you would
rather not restart to get one. Day to day, keys come from the Keys page or
`POST /api/v1/keys`.
</details>

### 5. Start the Client UI

In a **second terminal**, leaving the server running in the first:

```bash
bun run dev:client
```

Open **http://localhost:3001/home/** and fill in the form. It asks for a server,
not just a key:

| Field | Value |
|---|---|
| Name | anything — `local` |
| Server URL | `http://localhost:3000` |
| API key | the `linq_…` key from step 4 |

The details are checked against that server before they are saved, so a typo is an
error here rather than a blank page later. They are then kept in this browser only.

The UI is a client, not a page the server hands out. It holds a list of servers —
each a name, a URL and a key — and talks to whichever one you pick, so one UI
administers any number of instances and you switch between them at the foot of the
sidebar. Being served by a server grants it nothing: it always asks where to go,
even when the answer is the page's own address. That is why it can be deployed on
its own; see [Deploying the Client UI](#deploying-the-client-ui) and `docs/adr/0006`.

Because of that, the dev UI on port 3001 calls the API on port 3000 **across
origins**, exactly as a deployed one would. There is no proxy in between. The
server allows this; if you ever see requests fail with an opaque network error,
suspect CORS on the server rather than a missing proxy.

### Starting it again later

Steps 1–3 are one-time. After that it is Postgres, then two terminals:

```bash
bun run dev         # terminal 1 — API and redirects on :3000
bun run dev:client  # terminal 2 — Client UI on :3001
```

The server you added is still in your browser, so the UI opens straight onto it.
`bun run start` is the same server without `--watch`.

## Ports

The URLs below use the default ports. Substitute your configured values.

| URL | What it is |
|---|---|
| http://localhost:3001/home/ | Client UI, in development (default base path) |
| http://localhost:3000/home/ | Client UI, when the server serves the built export (default base path) |
| http://localhost:3000/api/v1 | REST API |
| http://localhost:3000/`slug` | A short link, which redirects |

`http://localhost:3000/` is not the Client UI. The root of a domain is a short
link like any other: it redirects to that domain's fallback URL, and 404s when
none is set. You can set one per domain on the Domains page. The one exception
is `LINQ_APP_HOST`, when it is set: that host is not a domain, and its root is
the UI.

## Everyday commands

```bash
bun run test      # server and client suites, in that order
bun run typecheck # tsc -b --force
bun run lint      # biome check .
bun run format    # biome check --write .
bun run build:client             # the export the server serves at LINQ_CLIENT_BASE_PATH
bun run build:client:standalone  # the export for a static host, at a domain root
bun run db:migrate   # apply pending Kysely migrations
bun run db:codegen   # regenerate Kysely query types from DATABASE_URL and LINQ_DB_SCHEMA
```

## Deploying the Client UI

There are two supported shapes, from one codebase.

**Served by linq**, the default. `bun run build:client` writes `apps/client/out`,
built for `LINQ_CLIENT_BASE_PATH` (`/home` by default), and the server serves it
from there. One process and one deployment — this is what the full Docker image
does.

**On its own**, anywhere that serves static files. `bun run build:client:standalone`
writes `apps/client/out-standalone`, built for a domain root. Upload that directory
to Vercel, Netlify, Cloudflare Pages, S3, nginx — it is plain files with no runtime.
Two things to get right:

- **Build it from a checkout of this repo**, not from `apps/client` alone. The UI
  imports `@linq/shared` as TypeScript over a workspace link and its tsconfig
  reaches the repo root, so the build command is `bun install && bun run
  build:client:standalone` with the whole repository present.
- **The export uses trailing slashes**, so the host must serve `x/index.html` for
  a request to `/x/`. Most hosts do this by default; S3 behind CloudFront needs an
  index document configured.

The two outputs are kept in separate directories on purpose: a root-path export
sitting in `apps/client/out` would be served at the combined deployment's base
path with every asset path wrong.

No API URL is compiled into either UI shape. The combined shape does compile its
base path into the static files; the standalone shape always uses `/`. A server
is added at runtime and stored in the browser, so one standalone
deployment serves any number of instances, and the people using it need no access
to the deployment to point it somewhere new.

Whichever shape you pick, the server accepts cross-origin API calls from any
origin. The API key is the only thing that authorises a request, and no cookie is
ever involved; `docs/adr/0006` has the reasoning.

## Where things are written

`./data` holds only the log file (`data/logs/linq.log`, rotated), and is
gitignored. In Docker it is the `/data` volume, and it is the one thing linq
writes to disk that is worth backing up.

## Docker

### Which image?

linq publishes one image, `linq`, to `labsatquicko/linq` on Docker Hub and
`ghcr.io/org-quicko/linq`, built from `docker/dockerfiles/Dockerfile`.
The other shapes are examples in `docker/examples/dockerfiles/`, built
locally. Pick by where the Client UI should live:

| You want | Image | Client UI at | Must set |
| --- | --- | --- | --- |
| One container, UI on its own domain | `linq` (published) | `/` on `LINQ_APP_HOST` only | `DATABASE_URL`, `LINQ_DEFAULT_DOMAIN`, `LINQ_APP_HOST` |
| One container, UI next to the short links | `Dockerfile` built with `LINQ_CLIENT_BASE_PATH=/home` | `/home` on every host | `DATABASE_URL`, `LINQ_DEFAULT_DOMAIN` |
| The API and short links, UI hosted elsewhere | `Dockerfile.server` (example) | nowhere | `DATABASE_URL`, `LINQ_DEFAULT_DOMAIN` |
| Only the UI, pointed at a linq server you run | `Dockerfile.client` (example) | `/` | nothing |

`linq` cannot start without `LINQ_APP_HOST`: the domain the UI answers on, for
example `linq.example.com`, while `link.example.com/<slug>` keeps serving short
links. Build the same Dockerfile with a path such as `/home` to put the UI
next to the short links instead; see
[The UI and API on their own host](#the-ui-and-api-on-their-own-host).

### Building and running

`docker/dockerfiles/Dockerfile` builds an image that serves the
API, the redirects and the Client UI from one process. Postgres stays external,
and so does Redis if you opt into it. Pick a matching file from
`docker/examples/docker-compose/`, configure the repo-root `.env`, then run the
matching `docker compose -f ... up` command. The examples load `.env` into the
`linq` service at runtime.

The image serves the UI at `/` by default, and the Compose examples build it
with `/home`. To use another path, rebuild the image with an explicit build
argument:

```sh
docker build --build-arg LINQ_CLIENT_BASE_PATH=/admin/example -f docker/dockerfiles/Dockerfile -t linq .
```

The path is written into the static frontend during `docker build`; changing
only the running container's environment would make the frontend and server
disagree. The Compose examples load the repo-root `.env` into `linq` and pass
`LINQ_CLIENT_BASE_PATH` to the build as well. Change that variable there, then
run `docker compose ... up --build`.

The Compose examples load `.env` into the `linq` service. Their bundled
Postgres variants also read `POSTGRES_USER`, `POSTGRES_PASSWORD`, and
`POSTGRES_DB` from it; replace the sample password before deploying. The
examples without Caddy read `LINQ_PORT` from `.env` to choose the published host port.
The container continues listening on 3000, so Caddy's internal upstream stays
`linq:3000`. For example, `LINQ_PORT=4000` publishes `4000:3000`.
The combined image serves the built UI on that same port. For a different env filename,
use `docker compose --env-file <file> ...`.

For a **separate client container**, `LINQ_CLIENT_PORT` sets its published
host port. For example, save this in `.env.ports` on your EC2 host:

```dotenv
LINQ_PORT=8080
LINQ_CLIENT_PORT=8081
```

Start the API and standalone client together from the repo root:

```sh
docker compose --env-file .env.ports -f docker/examples/docker-compose/01-bundled-postgres.yml -f docker/examples/docker-compose/10-client-only.yml up --build -d
```

The API and its bundled UI are available on port 8080 (`/api/v1` and
`/home/`); the standalone client is on port 8081 (`/`). Add your API's
browser-accessible URL, such as `http://<ec2-host>:8080`, in the client.
Neither container publishes host port 3000. Both can listen internally on
3000 because each has its own container network namespace. The standalone
client Compose file also works by itself against an API you already run.

If you deploy the UI separately, `docker/examples/dockerfiles/Dockerfile.server` is the same
image with the Client UI build stage dropped — the server answers 404 on its
configured Client UI path and carries on serving the API and the redirects. See
`docker/examples/README.md` for all the image shapes.

### The UI and API on their own host

To serve the UI at the root of one host and short links on others, from one
process, set two values:

```dotenv
LINQ_APP_HOST=linq.example.com      # UI at /, API at /api/*
LINQ_DEFAULT_DOMAIN=link.example.com # short links: link.example.com/<slug>
```

With `LINQ_APP_HOST` set, the UI answers only on that host, so it may sit at `/`
without taking over any short link. Every other host behaves exactly as before,
and `/api/*` still answers on all of them. The app host must differ from
`LINQ_DEFAULT_DOMAIN` and from every registered domain; linq refuses to start or
to create the domain otherwise. `docs/adr/0019` has the reasoning.

The UI at `/` needs an image built for it. `linq`, built from
`docker/dockerfiles/Dockerfile`, is the published image;
`docker/examples/docker-compose/11-app-host.yml` runs it. To build it yourself, set
`LINQ_CLIENT_BASE_PATH=/` in `.env` and use any combined example with `--build`.

Behind a reverse proxy, send both hosts to the same linq port and keep the
`Host` header, which is how linq tells them apart. With Caddy sync on, linq adds
the app host's route itself at boot. In the UI, add the server as
`https://linq.example.com`: the page and the API then share an origin.

### Custom domains with automatic HTTPS

Use one of the `with-caddy` or `full` examples (3, 4, 7, 8) in
`docker/examples/docker-compose/` — they already wire up the `caddy` service and
`LINQ_CADDY_ADMIN_URL` on `linq`. Once set, every domain
create, archive, reactivate and purge is pushed to Caddy as its own route —
adding a domain in linq is enough to make it resolve over HTTPS, with nothing
edited in Caddy by hand. `:2019`, Caddy's admin API, is never published to the
host — only linq ever talks to it, over the compose network. A custom domain
still needs its DNS pointed at the host before Caddy's automatic HTTPS can
issue it a certificate; see `docs/adr/0012`.

Those Caddy examples intentionally do **not** publish linq's port 3000 to the
host. Caddy reaches `linq:3000` inside the Compose network and is the only
public entry point, so API keys never travel through a plaintext bypass.

## Further reading

- `CONTEXT.md` — the domain vocabulary. Worth reading before the code.
- `docs/architecture.md` — how the pieces fit together today.
- `docs/repo-map.md` — where everything lives.
- `docs/adr/` — the decisions that are hard to reverse, and why.
