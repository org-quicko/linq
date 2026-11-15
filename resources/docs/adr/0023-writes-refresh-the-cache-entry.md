# 0023 – A create or edit writes its cache entry through

**Status**: accepted · 2026-11-15. Amends the invalidation rule in 0008;
everything else in 0008 and 0009 stands.

## Context

0008 had every mutation *delete* the cache entry it made stale, and left the
next redirect to rebuild it from Postgres. That is always correct, but it means
the first redirect after every create or edit pays the queries the cache exists
to avoid, and a create could only clear the slug's cached 404, never replace it.

Both backends sit behind one `Cache` interface, so a change in how a route
writes applies to Redis and to the in-memory LRU alike.

## Decision

A create or an edit *rewrites* the entry instead of deleting it, through
`writeThrough(cache, key, load)` in `libs/cache.ts`:

- `load` is the read path's own loader (`findActiveTarget`,
  `findActiveDomain`), so a written entry is exactly what a miss would have
  cached. An edit that archives through `status` therefore writes the `null`
  that the redirect now answers with.
- The key is deleted, then loaded, then set. `guardedCache` swallows a failed
  `set`, and without the delete that would leave the *previous* answer serving
  until `LINQ_CACHE_TTL`. With it, a failed write degrades to a miss.
- A `load` that throws is logged and leaves the key cleared; it does not fail
  the request, whose database write has already committed.

This covers link create and PATCH, replacing a link's rules, and domain create
and PATCH. Archive and purge endpoints still only delete: there is no new
answer to write. A domain's `llms.txt` is still deleted on every link write,
because re-rendering a whole catalogue per edit costs more than it saves.

## Consequences

- The first redirect after a create or edit is a cache hit. Each write costs
  one extra round of loader queries, on the admin path rather than the redirect.
- Two concurrent edits to one link can land their `set`s in the opposite order
  from their database writes, leaving the older answer cached until the TTL.
  Delete-only invalidation could not do this. Links are edited by hand, so the
  window is accepted; the TTL remains the backstop, as in 0008.
- A port-carrying variant of a domain's host is still cached under a key no
  mutation computes (see `domainKey`), and is still cleared only by the TTL.
- Neither backend changes. A single instance on the memory backend and several
  sharing Redis behave the same; the per-process limit of the memory backend
  described in 0009 is unchanged.
