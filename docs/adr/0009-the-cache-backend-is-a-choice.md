# 0009 – The cache backend is a choice

**Status**: accepted · 2026-09-17. Supersedes the requirement in 0008.

## Context

`docs/adr/0008` made Redis required. Its reasoning was that the redirect
lookups are shared state, so a per-process cache lets two instances behind a
load balancer disagree about a slug until the TTL runs out.

That reasoning still holds, and it is an argument about one deployment shape
rather than about every one. The cost of encoding it as a requirement is that a
single-process install — which is what `bun run dev` and the example compose
file both are — cannot start at all without a second piece of infrastructure
holding data that any one query can regenerate.

## Decision

There are two backends behind the `Cache` seam, selected by
`LINQ_CACHE_BACKEND`:

- `sqlite` — a `bun:sqlite` database opened at `:memory:`. In the process, no
  file, no volume, nothing to run alongside linq.
- `redis` — as before.

`none` is also accepted and disables caching outright; it replaces the earlier
convention of setting `LINQ_CACHE_TTL` to zero, so there is one way to say it
rather than two.

Left unset, `LINQ_CACHE_BACKEND` follows `LINQ_CACHE_BACKEND ?? (LINQ_REDIS_URL
? "redis" : "sqlite")`. Supplying a Redis URL is what says Redis is expected to
exist; naming `redis` without a URL is rejected at boot, and an explicit
`sqlite` wins over a URL that is present, so one can be left in `.env` while
trying the other.

**A configured Redis must be a reachable Redis.** `startCache` does not catch
the connect. Falling back silently would leave one instance's invalidations
invisible to the others, which is the failure 0008 was written about, arriving
quietly instead of loudly.

Both backends honour `LINQ_CACHE_TTL` — 300 seconds by default — identically,
so switching between them changes where an entry lives and nothing about how
long. SQLite has no expiring row, so there the TTL is stored as an `expires_at`
column, enforced on read against the clock, and reclaimed by a sweep on a
timer. The read path is what makes it correct; the sweep only reclaims memory.

## Consequences

- **Neither backend is the recommended one.** They differ in exactly one way:
  the SQLite store lives in one process, so its invalidations reach only that
  process, and a second instance can serve an entry the first one has already
  cleared until the TTL expires. Everything else — the keys, the TTL, the
  negative caching, the invalidation points — is identical. Which of those
  matters is a property of a deployment, not of linq.
- Postgres is once again the only thing linq requires to be running.
- The SQLite store is empty at every start, so a restart costs one query per
  link until it warms. It is also bounded: a cap on rows keeps a flood of
  requests for random slugs from growing it without limit, at the price of
  evicting by expiry rather than by use.
- The shipped cache is now testable without anything external, so the suite
  exercises the real implementation rather than a stand-in.
