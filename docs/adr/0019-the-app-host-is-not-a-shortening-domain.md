# 0019 – The app host is not a shortening domain

**Status**: accepted · 2026-09-24.

## Context

Until now every host a linq server answered was treated alike: `/api/*`, the
exported Client UI at `LINQ_CLIENT_BASE_PATH` (`/home` by default), and the
redirect catch-all for everything else. The UI had to live under a sub-path
because on a shortening domain every root-level path is a slug, so a UI at `/`
would have claimed every short link on every domain.

That made one common deployment impossible from a single process: the UI and
the API on their own host at its root (`linq.example.com/`,
`linq.example.com/api/*`), with short links on a different host
(`link.example.com/<slug>`). The only way to get the UI at a root was the
standalone client build (`Dockerfile.client`), a second container and a proxy
rule to split `/api/*` from `/`.

## Decision

A new, optional setting, `LINQ_APP_HOST`, names the one host that serves the
Client UI. When it is set:

- `mountAdmin` answers only when the request's `Host` matches `LINQ_APP_HOST`
  (as sent, then with its port stripped, the same way a domain row is matched).
  On any other host the UI route calls `next()`, and the request reaches the
  redirect handler exactly as before.
- `LINQ_CLIENT_BASE_PATH` may be `/`. Config refuses `/` without
  `LINQ_APP_HOST`, and a root mount reserves no slug, because it never answers
  on a shortening domain.
- `/api/*` still answers on every host. Nothing about the API is host-scoped.
- The app host cannot be a domain: config refuses a `LINQ_DEFAULT_DOMAIN`
  equal to it, and `POST /api/v1/domains` rejects it with a 400.
- The root of a host nobody registered redirects to the UI on the app host
  (`https://<app host><base path>/`) instead of a relative `/home/`.
- `robots.txt` on the app host disallows everything.
- With Caddy sync on (docs/adr/0012), `reconcileCaddy` pushes a fixed
  `domain:app-host` route for it at boot, since it has no domain row to sync
  from.

The app-host image is `docker/dockerfiles/Dockerfile` built with its default
base path, `/`. It is published as `linq`, the only published image.

Left unset, nothing changes: the UI answers on every host at
`LINQ_CLIENT_BASE_PATH`.

## Consequences

- Exactly one app host. A second admin hostname would mean turning the setting
  into a list; nothing needs that yet.
- The base path is still baked into the static export at build time
  (docs/adr/0006 keeps the API URL out of it, not the path). A root mount needs
  its own image; an image built with `/home` cannot be switched to `/` at
  runtime.
- An existing domain row whose host equals `LINQ_APP_HOST` is not rejected at
  boot, only at creation. Its links stop resolving, because the UI claims every
  path on that host. Archive it before setting `LINQ_APP_HOST`.
- The Caddy route for the app host is only written at boot. Changing
  `LINQ_APP_HOST` takes a restart, which a config change needs anyway.
- The UI stays a client (docs/adr/0006): it still asks which server to talk to.
  Pointing it at its own app host makes those calls same-origin, but any other
  server URL keeps working across origins.
