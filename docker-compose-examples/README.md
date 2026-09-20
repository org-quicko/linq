# Docker Compose examples

Every combination of linq's optional pieces — Postgres bundled vs. external,
Redis on/off (docs/adr/0009), Caddy on/off (docs/adr/0012). Pick the file that
matches your setup, copy it out, set a real password and `LINQ_DEFAULT_DOMAIN`,
then `docker compose -f <file> up`.

All `build:` and volume-mount paths in these files are relative to this
directory (`..` reaches the repo root), so run `docker compose` from here, or
copy the file elsewhere and fix those paths first.

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

See `../README.md` (Docker section) for what each piece does, and
`../docker-compose.example.yml` for the single annotated file these were
split out of.
