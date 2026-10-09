# 0008 – Redis fronts the redirect, and is required

**Status**: accepted · 2026-09-17. The requirement is superseded by 0009;
Redis is now one of two backends. Everything below is still the argument for
choosing it.

## Context

A redirect resolved 2–3 Postgres queries per request: the domain by host, the
link by slug, and the link's rules. All three are key lookups on indexed columns
whose answers change rarely — a link's destination is edited by hand, not by
traffic — on the one path in linq whose whole job is to answer in single-digit
milliseconds.

An in-process cache would have avoided a new dependency, but it is per-instance:
two linq processes behind a load balancer would disagree about a slug for as
long as their TTLs ran, and an edit made through one would not be visible to the
other. The lookups are shared state, so the cache has to be shared too.

## Decision

`LINQ_REDIS_URL` is required. The server exits on boot without it, the same way
it exits without `DATABASE_URL`. The redirect reads both lookups through Redis,
with the link's rules stored inside the link's entry so a hit answers the whole
request.

An answer of "there is no such domain" or "there is no such slug" is cached like
any other, so a flood of 404s costs one query per TTL rather than one per
request.

Requiring Redis to **boot** is not requiring it to **stay up**. Every cache
operation is wrapped at the seam where the app receives it: a read that throws
is a miss, and a write or an invalidation that throws is covered by
`LINQ_CACHE_TTL`. A Redis outage makes linq slower, never wrong and never down.

Entries are cleared by the mutation that invalidates them — create, update,
archive and purge on a link or domain, and replacing a link's rules — so the TTL
is a backstop, not the mechanism.

## Consequences

- Postgres is no longer the only infrastructure linq needs. An operator who
  loses Redis permanently has a server that will not start until they restore it
  or point `LINQ_REDIS_URL` somewhere else.
- No new npm dependency: Bun ships a Redis client, as it ships the Postgres one.
- The cache holds nothing durable, so it needs no volume, no backup and no
  migration. A cold Redis costs one query per link until it warms.
- Invalidation is by computed key, never a scan — every mutation knows the host
  or the domain-and-slug of the entry it invalidates.
- One case is left to the TTL: a domain row without a port that answered a
  request carrying one is cached under a key no mutation can compute. Every host
  linq is actually configured for clears immediately.
