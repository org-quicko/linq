# linq

Self-hosted SaaS including URL Shortener, Dynamic Link and Link Tree Creator

## Running it locally

### What you need

- **Bun 1.4+** — `bun --version`. If the command is not found, it installs to
  `~/.bun/bin` and that directory has to be on your `PATH`.
- **PostgreSQL 14+**, reachable on `localhost:5432`. linq never runs Postgres
  itself, locally or in Docker.

### 1. Install dependencies

```bash
bun install
```

### 2. Create the database

linq applies its own migrations at boot, but it will not create the database.

```bash
psql -U postgres -c "CREATE DATABASE linq;"
```

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

It runs migrations, creates the `admin` user on an empty database, and prints
that user's API key **once**:

```
  linq admin API key: linq_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  Store it now; it is not recoverable.
```

Copy it now — it is hashed in the database and cannot be read back. If you lose
it, drop the `users` table's rows and restart to mint a new one, or set
`LINQ_INITIAL_API_KEY` in `.env` before the first start to choose it yourself.

The server also downloads the ~8 MB DB-IP geolocation database on first boot. It
needs no account or key, and a failure is logged and ignored — clicks just have
no country. Set `LINQ_GEO_ENABLED=false` to skip it entirely.

### 5. Start the Admin UI

In a second terminal:

```bash
bun run dev:admin
```

Open **http://localhost:3001/admin/** and paste the API key.

In development the UI runs on its own Next.js server on port 3001 and proxies
`/api` through to the server on port 3000. In production there is no second
process: the UI is a static export that the server itself serves at `/admin`.

## Ports

| URL | What it is |
|---|---|
| http://localhost:3001/admin/ | Admin UI (development only) |
| http://localhost:3000/api/v1 | REST API |
| http://localhost:3000/`slug` | A short link, which redirects |

`http://localhost:3000/` is not the Admin UI. The root of a domain is a short
link like any other: it redirects to that domain's fallback URL, and 404s when
none is set. You can set one per domain on the Domains page.

## Everyday commands

```bash
bun test          # server test suite
bun run typecheck # tsc -b --force
bun run lint      # biome check .
bun run format    # biome check --write .
bun run build:admin
bun run db:generate  # generate a migration after editing db/schema.ts
```

`bun run start` runs the server without `--watch`.

## Where things are written

`./data` holds only the log file (`data/logs/linq.log`, rotated) and, in local
development, the geolocation database. Both are gitignored. In Docker the two
are split across separate volumes — `/data` for logs, `/geo` for the
regenerable geolocation cache. See `docs/adr/0005-geo-database-is-an-external-cache.md`.

## Docker

`Dockerfile` and `docker-compose.example.yml` build an image that serves the API,
the redirects and the Admin UI from one process. Postgres stays external. Copy
the compose file, set a real password and `LINQ_DEFAULT_DOMAIN`, then
`docker compose up`.

## Further reading

- `CONTEXT.md` — the domain vocabulary. Worth reading before the code.
- `docs/adr/` — the decisions that are hard to reverse, and why.
- `plans/` — the numbered plans each milestone was built from.
