# linq — Plan 13: the in-memory cache becomes an LRU

Follows `docs/plans/Plan_12.md`.

## Context

`docs/plans/Plan_12.md` made the cache backend a choice and gave the default an
in-memory `bun:sqlite` table. It works — the suite proves it — and it is more
machinery than the job needs. To hold a few thousand small values in one
process it carries a `create table`, five prepared statements, a `JSON.parse`
on every read and a `JSON.stringify` on every write, a sweep on a 60-second
timer, and a row cap implemented as a `delete … where key in (select … order by
expires_at limit max(0, …))` with a comment explaining that a negative SQLite
`LIMIT` means no limit.

It is also, by that cap, **not** an LRU. Eviction is by soonest expiry, which
under one uniform TTL is first-in-first-out. `apps/server/src/cache.ts:130-141`
and `docs/adr/0009` both record that as a known ceiling: under a flood of
requests for random slugs, the flood's own entries are the newest and survive
while real links get dropped.

What that store wants to be is a map with a size bound and an expiry, which is
exactly `lru-cache`. Swapping it in deletes the DDL, the statements, the
serialization and the timer, and replaces FIFO-under-pressure with real
eviction by use.

## Decisions

- **`lru-cache@^11.5.2`** becomes a direct dependency of `@linq/server`. Only
  `5.1.1` is in the tree today, pulled in transitively by `log-symbols`; v11 is
  a different package by API (named `LRUCache` export, `ttl` rather than
  `maxAge`) and the two coexist fine under Bun's isolated layout.
- **The backend is renamed `sqlite` → `memory`** everywhere the value appears:
  the config enum, `.env.example`, the README and ADR 0009. The name should say
  what it is rather than what it is built from, and nothing here is released,
  so this is a rename and not a migration.
- **Values are stored as objects, not JSON.** They never leave the process, so
  there is nothing to serialise for.
- **The TTL stays absolute from the write** — `updateAgeOnGet: false`, which is
  the default. Plan_12 §2's reasoning is unchanged: refreshing on read would
  mean a write per cache hit, and a permanently hot key would never re-read a
  row that changed behind the API's back.
- **The cap becomes a setting**, `LINQ_CACHE_MAX_ENTRIES`, defaulting to 10 000
  — down from the hard-coded 50 000, which was picked to bound a flood rather
  than to fit a working set. It counts entries, not bytes; §2 has the reasoning,
  the sizing and the Redis caveat.

One line of honesty, not an argument to have: a Map with delete-and-reinsert on
read is a genuine LRU in about twenty lines, and this repo has otherwise
preferred built-ins to dependencies (`bun-sql` over `pg`, `Bun.redis` over
`ioredis`). The package is being used because it was asked for and because it
is battle-tested on the parts that are easy to get subtly wrong — clock
handling, the interaction of TTL with size eviction, iteration during
mutation.

## 1. `apps/server/src/cache.ts`

The exported surface is unchanged except for the rename: `Cache`, `Hit<T>`,
`noCache`, `guarded`, `domainKey`, `targetKey`, `startCache`. `MAX_ENTRIES`
stops being exported — it stops existing, since the cap comes off the config
now. `redisCache` is untouched. Nothing that imports this file changes.

`sqliteCache` becomes `memoryCache`, and loses its `& { sweep }` return type —
there is no sweep to expose:

```ts
import { LRUCache } from "lru-cache"

export function memoryCache(config: Config): Cache {
  // The entry is stored as the `Hit` wrapper rather than the value itself, so
  // a cached `null` is a real object. lru-cache refuses a nullish value, and
  // this is the shape `get` has to return anyway.
  const store = new LRUCache<string, Hit<unknown>>({
    max: config.LINQ_CACHE_MAX_ENTRIES,
    ttl: config.LINQ_CACHE_TTL * 1000,
    updateAgeOnGet: false,
  })
  …
}
```

- `get` — `store.get(key) ?? null`, cast to `Hit<T> | null`. Expiry is checked
  on access, so a lapsed entry reads as a miss exactly as before.
- `set` — `store.set(key, { value })`. **No JSON.** The invariant this relies on
  is that nothing mutates a cached value: `redirect.ts` reads `fallbackUrl`,
  `destination`, `forwardQuery` and hands `rules` to `matchRules`, which only
  reads, and the visit object is built with a spread. That invariant is worth a
  comment, because it is the one thing dropping the serialisation gives up.
- `del` — a loop of `store.delete(key)`.
- `stop` — `store.clear()`. There is no handle to close and no timer to cancel.

**What goes away:** the `bun:sqlite` import, the table, all five statements,
`SWEEP_EVERY_MS`, the `setInterval`, and the `max(0, …)` trim. Memory is
bounded by `max` alone, and `lru-cache` reclaims expired entries as it goes, so
nothing needs a timer to stay flat.

## 2. `LINQ_CACHE_MAX_ENTRIES`

```
LINQ_CACHE_MAX_ENTRIES: z.coerce.number().int().min(1).max(1_000_000).default(10_000)
```

Bounded at both ends, the way `LINQ_SLUG_LENGTH` (4–32) and `LINQ_LOG_RETAIN`
(1–100) already are. The ceiling is not decoration: `lru-cache` pre-allocates
its index structures to `max`, so a typo of 100 000 000 would try to take
gigabytes at construction and fail at boot for a reason nobody would enjoy
diagnosing.

### Why a count and not a byte cap

Entries here are not uniform, so the question is a fair one. A negative entry
is ~170 B; a typical link with no rules is ~500 B; a link carrying a few rules
is ~2 KB. The schema permits far worse — `rulesPutSchema`
(`packages/shared/src/rules.ts:35`) allows 50 rules per link, each with a
2048-character destination and up to 10 conditions of 512 characters, which
works out at roughly 780 KB for a single entry.

A count cap therefore bounds memory like this:

| Cache contents | at 10 000 entries |
|---|---|
| Mostly negative entries, ~170 B | ~1.7 MB |
| Typical links, no rules, ~500 B | ~5 MB |
| Links carrying a few rules, ~2 KB | ~20 MB |
| Schema-maximum links, ~780 KB | ~7.8 GB |

The last row is what argues for `maxSize`, and it is the row that does not
happen by accident. Reaching it means an authenticated author creating
thousands of links with 50 maximal rules each **and** driving traffic to all of
them inside the five-minute TTL — and anyone who can do that can do worse to
Postgres directly. The unauthenticated attack this cap was actually written
for, slug scanning, produces only the first row.

Across the three realistic rows the spread is about 12×, and the whole band
sits between 2 and 20 MB. That is narrow enough, and small enough in absolute
terms, that precision is not worth its price.

And the price is real. A byte cap needs a `sizeCalculation`, and the number it
returns would be invented: JS engines use one-byte and two-byte string
representations, rope and sliced strings, hidden classes and dictionary-mode
objects, so an estimator can be off by a factor of two or four with no way to
validate it from inside the process. `LINQ_CACHE_MAX_MB=32` would be a setting
that lies — the operator sets 32, measures the process, and finds something
else. A cap that is honest and coarse beats one that looks precise and is not.

The tiebreaker is code. A count is `max: N`: nothing to write, nothing to test,
nothing to caveat. `maxSize` stays available as the escape hatch if a real
install ever shows memory varying in a way that matters, which is the right
moment to add it — with a measurement rather than a worst case.

### Choosing a value

The TTL, not the cap, bounds the *useful* size: an entry only pays off if its
key is asked for twice inside five minutes, so anything past the five-minute
working set expires before it can be read. Traffic to short links is sharply
skewed, so a cache far smaller than the link table still hits on nearly every
request, and 10 000 sits well above the distinct links a self-hosted instance
serves in that window.

Going bigger also costs memory before it holds anything: at `max: 50 000` the
pre-allocated arrays are roughly 1.8 MB against ~0.36 MB at 10 000, paid
whether or not the cache ever fills. **Confirm those figures against the
installed package when implementing** — the shape of the claim is the point,
not the decimal.

The setting exists for the one input this plan cannot know: how many distinct
links an install actually serves in five minutes. An operator who knows that
number should round it up; everyone else should leave it alone.

### Redis cannot honour it

A client has no way to cap a Redis keyspace by count; eviction there is the
server's, set with `maxmemory` and `maxmemory-policy allkeys-lru` in
`redis.conf`. The setting is named for the cache in general because it is the
cache's concern, and is documented as taking effect on the in-memory backend
only, with a pointer at `maxmemory` for the other. Naming it
`LINQ_MEMORY_CACHE_MAX` would be more literal today and would need renaming the
day any other backend can enforce a count.

## 3. Config and naming

`apps/server/src/config.ts:15` and `:68` — the enum becomes
`["memory", "redis", "none"]` and the derived default becomes
`c.LINQ_CACHE_BACKEND ?? (c.LINQ_REDIS_URL ? "redis" : "memory")`. The rest of
Plan_12's selection rules are unchanged: an explicit setting wins over a URL
that is present, and `redis` without a URL is still rejected by the
`superRefine`.

`LINQ_CACHE_MAX_ENTRIES` joins the schema next to `LINQ_CACHE_TTL`, and
`testConfig` in `apps/server/test/helpers/db.ts:19` gets it too — that literal
is a full `Config`, so it fails to compile until it does.

`apps/server/package.json` gains `"lru-cache": "^11.5.2"` in `dependencies`,
and `bun install` regenerates the lock.

## 4. Tests

`apps/server/test/cache.test.ts` keeps its read-through and invalidation blocks
verbatim — they run against `memoryCache` now, and that is the whole point of
the `Cache` seam. The backend block changes shape:

- **Renamed** `the sqlite backend` → `the memory backend`, `sqliteCache` →
  `memoryCache` throughout, and `testConfig.LINQ_CACHE_BACKEND` in
  `apps/server/test/helpers/db.ts:23` becomes `"memory"`.
- **Kept** — round trip, cached `null` is not a miss, a second write replaces
  the value, `del` removes one key and leaves its neighbours, and the ~1.1s
  case proving an entry past its TTL reads as a miss.
- **Dropped** — `the sweep is what actually reclaims the row`. There is no
  sweep; expiry is checked on access and the bound is `max`.
- **Replaced** — `the cap bounds the table` tested a count through the old
  `sweep()` return, and needed 50 010 writes to do it. Now that the cap is a
  setting the tests open a cache at `LINQ_CACHE_MAX_ENTRIES: 3` and assert the
  property in four writes:
  - writing past the cap evicts the least recently used entry;
  - **reading** an entry before the overflow makes it survive, while the one
    next to it is evicted instead. That is the difference between LRU and the
    FIFO this plan exists to remove, so it is the test that would have failed
    before.

  Making the cap configurable is what turns that from a slow, indirect
  assertion into a fast, exact one — reason enough for the setting on its own.
- **Changed** — `stop closes the store` becomes `stop empties the store`: after
  `stop()` a read is a miss rather than a throw, since there is no handle to
  close.
- **Dropped** — the degradation case `a sqlite store closed underneath the
  server still redirects`. There is no way to make an LRU throw, and the
  `throws on every call` case above it already proves `guarded` does its job.

## 5. Documentation

- **`docs/adr/0009`** — amended in place, following the precedent in
  `docs/adr/0002`. The decision is unchanged; only its implementation is. The
  `sqlite` bullet at `:22` and the TTL paragraph at `:43` describe an LRU
  instead, and the consequences at `:50-56` drop the FIFO caveat, since
  eviction is now by use. Worth one added line: this is the first runtime
  dependency the server has taken for something a built-in could do, and the
  reason is that a cache's eviction and expiry interact in ways worth not
  reimplementing.
- **`.env.example:4-12`** — `sqlite` → `memory` in the enum line and the
  three-line description, plus a new commented `LINQ_CACHE_MAX_ENTRIES` block
  under `LINQ_CACHE_TTL`. It has to say three things: that the number counts
  entries rather than bytes, that the memory backend is the one that enforces
  it, and that a Redis keyspace is capped with `maxmemory` in `redis.conf`
  instead.
- **`README.md:16`** — "an in-memory SQLite store" → an in-memory LRU.
- `docker-compose.example.yml` needs nothing; it never named the backend.

## Sequencing

One commit. The rename, the swap and the tests are the same change, and the
suite is only green with all three.

## Verification

1. `bun install`, then `bun run typecheck`, `bunx biome check .`, `bun test` —
   the read-through and invalidation blocks must pass **unmodified**, which is
   what proves the swap is behaviour-preserving at the seam.
2. The LRU case specifically: the new test that reads a key to save it from
   eviction should fail against the old implementation if pointed at it, and
   pass here. Worth running once against `sqliteCache` before deleting it.
3. `grep -rn "sqlite" apps docs README.md .env.example | grep -v pglite` returns
   nothing but the plans, which are frozen records.
4. Start the server with no `LINQ_REDIS_URL` and confirm the boot line says
   `backend: "memory"`. Hit a slug twice at `LINQ_LOG_LEVEL=debug`: the second
   hit shows no `link.findActive` span. Edit the link through the API and hit it
   again: the new destination is served immediately.
5. `LINQ_CACHE_BACKEND=redis` with a reachable Redis still behaves as before —
   the file it shares with this change is only the switch in `startCache`.

## Risks

- **Cached values are now shared references.** Dropping the JSON round trip
  means two requests hold the same object. Nothing mutates one today; a future
  change that does would corrupt the cache rather than one response, and would
  not be caught by any existing test. The comment in `set` is the whole
  defence — a deep freeze on write would cost more than it protects.
- **A new runtime dependency** on the server, which has so far had nine and
  preferred Bun built-ins. `lru-cache` is small and dependency-free in v11, but
  it is a precedent.
- **The cap counts entries, so memory is bounded only within a band.** 10 000
  entries is ~2 MB of negative entries or ~20 MB of rule-carrying links, and in
  the schema-maximum case §2 describes it is far more. The band is acceptable
  because reaching the top of it takes authenticated abuse, not traffic — but
  it is a band, not a number, and `.env.example` should not pretend otherwise.
- **One setting, one backend that obeys it.** An operator who sets
  `LINQ_CACHE_MAX_ENTRIES` while running Redis will see nothing happen. The
  documentation is the only thing preventing that surprise; the alternative —
  rejecting the combination at boot — would be worse, since it would break the
  perfectly reasonable case of a single `.env` shared across environments that
  use different backends.
