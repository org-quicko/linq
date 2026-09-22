# Docker Compose examples

Every combination of linq's optional pieces — Postgres bundled vs. external,
Redis on/off (docs/adr/0009), Caddy on/off (docs/adr/0012). Pick the file that
matches your setup, copy it out, set a real password and `LINQ_DEFAULT_DOMAIN`,
then `docker compose -f <file> up`.

All `build:` and volume-mount paths are resolved relative to the Compose
file's directory (`..` reaches the repo root), not your shell's directory.
Run from here, or use `-f docker-compose-examples/<file>` from the repo root.
If you copy a file elsewhere, fix those paths first.

Set `LINQ_PORT` in the repo-root `.env` to change the published port from
3000. Run from the repo root, or pass `--env-file ../.env` when running from
this directory. The container and Caddy upstream stay on port 3000.
`LINQ_DEFAULT_DOMAIN` can also be set in that env file; when absent, it
defaults to `localhost:<LINQ_PORT>`. For an existing database, change the
domain through the UI as well: the default domain only seeds an empty database.

| File | Postgres | Redis | Caddy |
| --- | --- | --- | --- |
| `docker-compose.bundled-postgres.yml` | bundled | – | – |
| `docker-compose.bundled-postgres.with-redis.yml` | bundled | yes | – |
| `docker-compose.bundled-postgres.with-caddy.yml` | bundled | – | yes |
| `docker-compose.bundled-postgres.full.yml` | bundled | yes | yes |
| `docker-compose.external-postgres.yml` | external | – | – |
| `docker-compose.external-postgres.with-redis.yml` | external | yes | – |
| `docker-compose.external-postgres.with-caddy.yml` | external | – | yes |
| `docker-compose.external-postgres.full.yml` | external | yes | yes |

`docker-compose.client.yml` runs the standalone Client UI at `/`, with no
API or database. Its host port is `${LINQ_CLIENT_PORT:-3001}`, read from
your env file; its internal port stays 3000. To run it alongside one of
the API examples from the repo root:

```sh
docker compose --env-file .env -f docker-compose-examples/docker-compose.bundled-postgres.yml -f docker-compose-examples/docker-compose.client.yml up --build -d
```

For example, `LINQ_PORT=8080` and `LINQ_CLIENT_PORT=8081` publish the API on
8080 and the standalone UI on 8081, leaving host port 3000 free. Choose
distinct, unused host ports. The combined API image already includes a UI
at `/home/` on `LINQ_PORT`; the separate client is optional.

"External" Postgres means no `postgres` service in the file — set
`DATABASE_URL` on the `linq` service to point at your own instance instead.

For a local check from the repo root:

```sh
docker compose -f docker-compose-examples/docker-compose.bundled-postgres.yml up --build -d
docker compose -f docker-compose-examples/docker-compose.bundled-postgres.yml logs linq
curl http://localhost:3000/api/health
```

Open `http://localhost:3000/home/` for the UI and use the admin key printed
in the logs. Substitute any other example filename to try that stack. Stop
one before starting another: they publish the same host ports and share a
default Compose project name. Use `down` with the same `-f` argument to stop
it; add `--volumes` only when you intend to delete its stored data.

For external Postgres on the Docker Desktop host, use
`host.docker.internal` in `DATABASE_URL`, not `localhost` (which refers to
the linq container). The example URL is a placeholder: edit the Compose
environment entry itself, or supply a Compose override; exporting
`DATABASE_URL` in your shell does not replace that literal entry.

Caddy examples publish ports 80 and 443 in addition to 3000. With the
default localhost domain, `https://localhost/api/health` uses Caddy's local
CA; trust that CA or use `curl -k` for this local smoke check. Public
certificate issuance still requires a real domain, public DNS, and inbound
ports 80/443, and cannot be validated by a localhost-only test.

See `../README.md` (Docker section) for what each piece does, and
`../docker-compose.example.yml` for the single annotated file these were
split out of.
