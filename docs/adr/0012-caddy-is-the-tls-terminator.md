# 0012 – Caddy is the TLS terminator

**Status**: accepted · 2026-09-17.

## Context

`links.ts` has long assumed that production linq sits behind "something" that
terminates TLS — nothing ever did. A domain (`domains.ts`) was only ever a row:
creating one taught nothing outside the database that a new host existed. There
was no reverse proxy, no certificate, no routing.

## Decision

Caddy runs as a sidecar container, and linq keeps it in sync over its admin API
(`:2019`, JSON, reachable only inside the compose network — never published to
the host). Caddy's own automatic HTTPS issues and renews a certificate for
every host it is given a route for; nothing about certificates is written here.

**Each domain is synced as its own route, addressed by a stable id
(`domain:<uuid>`), never as a full list.** A create or reactivation does
`DELETE /id/domain:<id>` (tolerating a 404 — that is the idempotent case, not a
failure) followed by one `POST` of a route tagged with that same `@id`. An
archive, delete, or purge does the one `DELETE`. No mutation ever reads or
rewrites another domain's route.

This was chosen over recomputing and `PUT`ting the entire route array on every
mutation. A full replace costs the same — one HTTP round trip carrying every
active domain's route — whether one domain changed or a thousand exist, and
any two admins touching two different domains at once would contend over that
one shared array. Per-`@id` routing makes the cost and the blast radius of a
mutation depend only on the domain it touches.

The full active-domain list is read in exactly one place: `reconcileCaddy`,
called once at linq boot. That is deliberate — it is the only case where the
full set is actually needed, because it is the only case addressing a single
domain cannot fix: Caddy's own restart wipes its in-memory config back to the
empty skeleton in `docker/examples/dockerfiles/caddy/caddy.json`, and every domain has to be re-added at
once to repair it. A boot-time cost is fine to pay in full; a per-request one
is not.

**A sync failure never fails the domain request.** `guarded(caddy)` — mirroring
`guarded(cache)` in `cache.ts` exactly — catches, logs at `error`, and lets the
response succeed regardless. The next successful mutation on that domain, or
the next linq boot, repairs whatever this missed.

**This is not the same call `docs/adr/0009` makes about Redis.** A configured
Redis that cannot be reached is fatal at boot, because a cache two instances
disagree about is the exact failure that ADR exists to prevent. Caddy is the
other way around: Caddy depends on linq being reachable at
`LINQ_CADDY_UPSTREAM`, not linq on Caddy. Refusing to boot linq because its own
reverse proxy is momentarily down would invert that dependency, so an
unreachable Caddy — at boot or at any mutation — is logged and never fatal.

**The feature is entirely opt-in.** Unset `LINQ_CADDY_ADMIN_URL` and every
domain route becomes `noCaddy`, whose `upsert`/`remove` do nothing. Every
existing install, every test, and the example compose file's Caddy block
(commented out, exactly like its Redis block) keep working unchanged.

## Consequences

- Automatic HTTPS still needs what it has always needed: public DNS pointed at
  the host, and ports 80/443 reachable from the internet. Nothing here changes
  that; a local or LAN-only compose setup will see Caddy retry ACME validation
  and fail quietly in its own logs.
- `upsert`'s delete-then-add is two HTTP calls, not one transaction. A request
  landing in the gap between them sees no route for *that* domain, for one
  round trip to `:2019`. No other domain is affected.
- A sync that fails mid-outage leaves one domain's route stale until its next
  mutation or the next linq boot. There is no cache-style TTL backstop; this is
  acceptable because the staleness is scoped to the one domain that failed.
- Caddy's own restart is the one event that needs the whole `domains` table
  re-read. Everything else — create, patch, archive, purge — touches exactly
  one route.
