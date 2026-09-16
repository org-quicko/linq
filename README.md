# linq

Self-hosted SaaS including URL Shortener, Dynamic Link and Link Tree Creator

## Running it locally

### What you need

- **Bun 1.4+** — `bun --version`. If the command is not found, it installs to
  `~/.bun/bin` and that directory has to be on your `PATH`.
- **PostgreSQL 14+**, running and reachable on `localhost:5432`. linq never runs
  Postgres itself, locally or in Docker — start it before the steps below, or the
  server exits on boot with `ERR_POSTGRES_CONNECTION_REFUSED`.

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

Then edit `.env` and set `DATABASE_URL` to your own Postgres credentials. That is
the only required value; everything else has a working default. The defaults put
the server on port 3000 and seed `localhost:3000` as the first domain.

### 4. Start the API server

```bash
bun run dev
```

Leave it running; it serves the API the Client UI talks to.

On an **empty** database it also creates the `admin` user and prints that user's
API key, once:

```
  linq admin API key: linq_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  Store it now; it is not recoverable.
```

Copy it now — only its hash is stored, so it cannot be read back. This happens
only while the `users` table is empty: every later start prints nothing, which is
what you will see on a database you have used before.

To choose the key yourself instead, set `LINQ_INITIAL_API_KEY` in `.env` **before**
the first start.

<details>
<summary>Lost the key on a database you have already used</summary>

Mint another one directly. Save this as `mint-key.ts` in the repo root and run
`bun --env-file=.env mint-key.ts`:

```ts
import { SQL } from "bun"
import { generateKey, hashKey, keyPrefix } from "./apps/server/src/auth/keys.ts"

const db = new SQL(Bun.env.DATABASE_URL)
const [user] = await db`select id from users where role = 'admin' order by created_at limit 1`
if (!user) throw new Error("no admin user; start the server against an empty database instead")

const key = generateKey()
await db`insert into api_keys (id, user_id, label, key_hash, prefix)
         values (${crypto.randomUUID()}, ${user.id}, 'recovered', ${hashKey(key)}, ${keyPrefix(key)})`
console.log(`\n  linq admin API key: ${key}\n  Store it now; it is not recoverable.\n`)
await db.end()
```

Emptying the `users` table to force a fresh bootstrap only works while no links
exist: `links.owner_id` is `ON DELETE RESTRICT`, so once anything is owned, the
delete is refused rather than quietly orphaning it.
</details>

The server also downloads the ~8 MB DB-IP geolocation database on first boot. It
needs no account or key, and a failure is logged and ignored — clicks just have
no country. Set `LINQ_GEO_ENABLED=false` to skip it entirely.

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

| URL | What it is |
|---|---|
| http://localhost:3001/home/ | Client UI, in development |
| http://localhost:3000/home/ | Client UI, when the server serves the built export |
| http://localhost:3000/api/v1 | REST API |
| http://localhost:3000/`slug` | A short link, which redirects |

`http://localhost:3000/` is not the Client UI. The root of a domain is a short
link like any other: it redirects to that domain's fallback URL, and 404s when
none is set. You can set one per domain on the Domains page.

## Everyday commands

```bash
bun run test      # server and client suites, in that order
bun run typecheck # tsc -b --force
bun run lint      # biome check .
bun run format    # biome check --write .
bun run build:client             # the export the server serves at /home
bun run build:client:standalone  # the export for a static host, at a domain root
bun run db:generate  # generate a migration after editing db/schema.ts
```

## Deploying the Client UI

There are two supported shapes, from one codebase.

**Served by linq**, the default. `bun run build:client` writes `apps/client/out`,
built for the `/home` sub-path, and the server serves it from there. One process,
one deployment, nothing to configure — this is what the Docker image does.

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
sitting in `apps/client/out` would be served by the server at `/home` with every
asset path wrong.

The UI needs no build-time configuration either way — no API URL is compiled in.
A server is added at runtime and stored in the browser, so one standalone
deployment serves any number of instances, and the people using it need no access
to the deployment to point it somewhere new.

Whichever shape you pick, the server accepts cross-origin API calls from any
origin. The API key is the only thing that authorises a request, and no cookie is
ever involved; `docs/adr/0006` has the reasoning.

## Where things are written

`./data` holds only the log file (`data/logs/linq.log`, rotated) and, in local
development, the geolocation database. Both are gitignored. In Docker the two
are split across separate volumes — `/data` for logs, `/geo` for the
regenerable geolocation cache. See `docs/adr/0005-geo-database-is-an-external-cache.md`.

## Docker

`Dockerfile` and `docker-compose.example.yml` build an image that serves the API,
the redirects and the Client UI from one process. Postgres stays external. Copy
the compose file, set a real password and `LINQ_DEFAULT_DOMAIN`, then
`docker compose up`.

If you deploy the UI separately, the image still works with the export left out —
the server answers 404 on `/home/*` and carries on serving the API and the
redirects. Dropping the first build stage and the `COPY --from=build` line gives
you a smaller, API-only image.

## Further reading

- `CONTEXT.md` — the domain vocabulary. Worth reading before the code.
- `docs/adr/` — the decisions that are hard to reverse, and why.
- `plans/` — the numbered plans each milestone was built from.
