# Docker Compose examples

Every combination of linq's optional pieces — Postgres bundled vs. external,
Redis on/off (docs/adr/0009), Caddy on/off (docs/adr/0012). Pick the file that
matches your setup, copy it out, set a real password and `LINQ_DEFAULT_DOMAIN`,
then `docker compose -f <file> up`.

All `build:` and volume-mount paths are resolved relative to the Compose
file's directory (`..` reaches the repo root), not your shell's directory.
Run from here, or use `-f docker-compose-examples/<file>` from the repo root.
If you copy a file elsewhere, fix those paths first.

| File | Postgres | Redis | Caddy |
| --- | --- | --- | --- |
| `docker-compose.minimal.yml` | bundled | – | – |
| `docker-compose.with-redis.yml` | bundled | yes | – |
| `docker-compose.with-caddy.yml` | bundled | – | yes |
| `docker-compose.full.yml` | bundled | yes | yes |
| `docker-compose.external-postgres.yml` | external | – | – |
| `docker-compose.external-postgres.with-redis.yml` | external | yes | – |
| `docker-compose.external-postgres.with-caddy.yml` | external | – | yes |
| `docker-compose.external-postgres.full.yml` | external | yes | yes |

"External" Postgres means no `postgres` service in the file — set
`DATABASE_URL` on the `linq` service to point at your own instance instead.

For a local check from the repo root:

```sh
docker compose -f docker-compose-examples/docker-compose.minimal.yml up --build -d
docker compose -f docker-compose-examples/docker-compose.minimal.yml logs linq
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
