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

- `memory` — an `lru-cache` held in the process. No file, no volume, nothing
  to run alongside linq.
- `redis` — as before.

`none` is also accepted and disables caching outright; it replaces the earlier
convention of setting `LINQ_CACHE_TTL` to zero, so there is one way to say it
rather than two.

Left unset, `LINQ_CACHE_BACKEND` follows `LINQ_CACHE_BACKEND ?? (LINQ_REDIS_URL
? "redis" : "memory")`. Supplying a Redis URL is what says Redis is expected to
exist; naming `redis` without a URL is rejected at boot, and an explicit
`memory` wins over a URL that is present, so one can be left in `.env` while
trying the other.

**A configured Redis must be a reachable Redis.** `startCache` does not catch
the connect. Falling back silently would leave one instance's invalidations
invisible to the others, which is the failure 0008 was written about, arriving
quietly instead of loudly.

Both backends honour `LINQ_CACHE_TTL` — 300 seconds by default — identically,
so switching between them changes where an entry lives and nothing about how
long. The TTL runs from the write and never slides: refreshing it on read would
cost a write per cache hit, and a permanently hot key would then never re-read
a row that changed behind the API's back.

The memory backend is additionally capped by `LINQ_CACHE_MAX_ENTRIES`, which
Redis cannot honour — a client has no way to cap a keyspace by count, so that
is `maxmemory` in `redis.conf` instead.

It also sweeps. `lru-cache` does not remove lapsed entries on its own: they keep
their slot and keep counting toward the cap, so a store full of expired keys can
evict live ones. One interval calls `purgeStale`, on the TTL and capped at a
minute, so an entry outlives its expiry by at most one period. It is one timer
for the store rather than `ttlAutopurge`, which arms a timeout per cached entry
and pays a `clearTimeout`/`setTimeout` on every write — the redirect's miss path.
This changes no answer: expiry was already checked on access.

## Consequences

- **Neither backend is the recommended one.** They differ in exactly one way:
  the memory store lives in one process, so its invalidations reach only that
  process, and a second instance can serve an entry the first one has already
  cleared until the TTL expires. Everything else — the keys, the TTL, the
  negative caching, the invalidation points — is identical. Which of those
  matters is a property of a deployment, not of linq.
- Postgres is once again the only thing linq requires to be running.
- The memory store is empty at every start, so a restart costs one query per
  link until it warms. It is bounded by `LINQ_CACHE_MAX_ENTRIES`, which keeps a
  flood of requests for random slugs from growing it without limit, and which
  evicts by use rather than by age.
- That cap counts entries, not bytes, so the memory it implies varies with what
  is cached — roughly 2 MB of negative entries or 20 MB of rule-carrying links
  at the default of 10 000. A byte cap was considered and rejected: it needs a
  size estimator whose number cannot be validated from inside the process, and
  would read as precise while being approximate.
- `lru-cache` is the first runtime dependency the server has taken for
  something a built-in could do. A map with delete-and-reinsert on read is an
  LRU in about twenty lines; the package is used because eviction and expiry
  interact in ways worth not reimplementing.
- The shipped cache is now testable without anything external, so the suite
  exercises the real implementation rather than a stand-in.
