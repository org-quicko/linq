# linq — Plan 23: persist Caddy's domain routes across its own restart

Follows `plans/Plan_22.md`.

## Context

Per `docs/adr/0012-caddy-is-the-tls-terminator.md`, Caddy holds every domain
route only in memory. When linq restarts, `reconcileCaddy` re-pushes every
active domain from the `domains` table, so that case is already covered. But
if **Caddy alone** restarts — its container gets bounced independently by the
host platform, or a manual `docker compose restart caddy` — its routes are
wiped back to the empty skeleton in `caddy/caddy.json` and stay empty until
linq's next boot or the next domain mutation. During that window, every
custom domain resolves to nothing.

Caddy already supports fixing this natively: every admin-API change is
autosaved to JSON on disk, at `$XDG_CONFIG_HOME/caddy/autosave.json`. The
official `caddy:2` image points `XDG_CONFIG_HOME` at `/config` — the exact
volume both compose files already mount (`caddy-config:/config`, `docker-
compose.yml:22` and `docker-compose.example.yml:46`). Passing `--resume` on
`caddy run` makes Caddy load that autosaved state on start instead of always
reloading `caddy.json` from scratch. This closes the gap ADR 0012 left open,
using a built-in Caddy flag — no new dependency, no new volume, no app code
change.

## Change

In both `docker-compose.yml:18` and the commented-out Caddy block in
`docker-compose.example.yml:42`, change:

```yaml
command: caddy run --config /etc/caddy/caddy.json
```

to:

```yaml
command: caddy run --config /etc/caddy/caddy.json --resume
```

`--resume` falls back to `--config` on first boot, when there's no autosave
yet, so this is safe for a brand-new deployment too.

No other file needs to change — the `caddy-config:/config` volume mount is
already present in both compose files.

## Verification

```
docker compose up -d
```

1. Create a domain via linq's API so it pushes a route to Caddy.
2. Confirm the route exists: `docker compose exec caddy wget -qO- http://localhost:2019/config/apps/http/servers/srv0/routes`.
3. Restart **only** the caddy container: `docker compose restart caddy` (leave
   linq running, so `reconcileCaddy` never runs).
4. Re-run the same admin-API check — the route should still be present.
5. Confirm the persisted file backs it: `docker compose exec caddy cat /config/caddy/autosave.json`.

## Risks

- `--resume` is scoped to this one compose command; it doesn't change
  anything about how routes are pushed or removed, so it carries no risk to
  the delete-then-add upsert flow ADR 0012 already covers.
