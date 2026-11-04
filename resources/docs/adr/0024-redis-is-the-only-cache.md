# 0024 – Redis is the only cache, and writes go through it

**Status**: accepted · 2026-11-04. Supersedes 0009.

## Context

0009 made the cache backend a choice: an in-process LRU by default, Redis when
`LINQ_REDIS_URL` was set, or none. Writes kept it fresh by deleting the
affected entries, and the next redirect missed once and rebuilt them.

Two things were wrong with that once linq had more than one way in:

- **Freshness is per process on the memory backend.** A write deletes the
  entry only in the process that made it. Every other process keeps serving
  the old destination until `LINQ_CACHE_TTL` lapses. 0009 accepted this; it
  stops being acceptable when an MCP client edits a link and expects the next
  redirect to reflect it.
- **Delete-on-write has a race that no version check can close.** A redirect
  that reads the row just before an edit commits, and writes its result just
  after the edit's delete, puts the old entry back until the TTL. Fixing that
  needs a compare-and-set that every process honours, which means one shared
  store.

Two backends also meant two code paths, a sweep timer, and two settings
(`LINQ_CACHE_SWEEP_INTERVAL`, `LINQ_CACHE_MAX_ENTRIES`) that did nothing on
Redis.

## Decision

Redis is required, and is the only cache.

- `LINQ_REDIS_URL` is required, and Redis must be reachable at boot or linq
  refuses to start. A Redis that dies after boot still degrades to Postgres
  through `guarded()`, as before.
- `LINQ_CACHE_BACKEND` is removed. `memory` or `none` fail at boot with a
  message naming the change, because silently moving a 1.x deployment onto a
  service it does not run, or off caching altogether, would hide the
  decision. `redis` is accepted and ignored. `LINQ_CACHE_SWEEP_INTERVAL` and
  `LINQ_CACHE_MAX_ENTRIES` are removed, and so is `lru-cache`.
- **Writes go through.** After a link, its rules or a domain is created,
  edited or archived, the service rebuilds the redirect's entry with the
  same loader the redirect uses (`redirect/resolve.ts`) and writes it,
  instead of deleting it. The next redirect is a hit with the new value.
- **Every write is versioned.** An entry is stored as `{ v, value }`, where `v`
  is the row's `updated_at` in epoch milliseconds, or 0 when there is no row.
  A Lua script compares and writes in one step and refuses to replace a
  strictly newer version. The redirect's own cache-through write carries the
  version it read too, which closes the race above from both sides.
  - An archived link or domain still has a row, so archiving writes a `null`
    that outranks the live entry it replaces.
  - Replacing a link's rules bumps the link's `updated_at`, because the
    rules are part of its entry.
- **Deletes stay where nothing can be versioned.** Purge deletes, because
  with the row gone the loader reads version 0, which could never outrank
  the entry it has to remove. `/llms.txt` is built from every listed link on
  a domain, has no single row to version, and is rarely read, so it is still
  deleted on write.
- Keys move to a `linq:2:` prefix, so a 1.x entry left in Redis is never read
  as the new format and lapses on its TTL.

## Considered options

- **Keep the memory backend, add write-through to both.** A write would
  still reach only its own process, and the version check could not span
  processes, so the race and the per-process staleness would both remain.
- **Keep Redis optional, falling back to no cache.** Rejected for this
  release: a deployment without Redis would quietly put every redirect on
  Postgres, and supporting "no cache" still needs a code path the tests and
  docs have to keep covering.

## Consequences

- Redis is a hard dependency, reversing AGENTS.md's "neither is required"
  for Redis. Every docker compose example now runs it. Caddy stays optional.
- `bun run test` still needs nothing running. Suites use an in-process fake
  that keeps the versioned-write rule (`test/helpers/cache.ts`). The real
  backend and its Lua script are tested by `test/redis-cache.test.ts`, which
  runs only when `TEST_REDIS_URL` is set.
- Versions come from the clock of whichever process wrote the row. Clock skew
  between linq processes larger than the gap between two edits of the same
  row could make the later edit's entry lose to the earlier one until the
  TTL. Edits under one millisecond apart compare equal, and the later write
  wins.
- Purge and `/llms.txt` keep delete-on-write's single miss and its race,
  narrowed to those two paths.
- This is a breaking change: 2.0.0.
