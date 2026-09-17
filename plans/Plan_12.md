# linq — Plan 12: Redis becomes one cache backend, not the only one

Follows `plans/Plan_11.md`.

## Context

`plans/Plan_11.md` put Redis in front of the redirect and made it required:
`LINQ_REDIS_URL` has no default, and `loadConfig` exits without it
(`apps/server/src/config.ts:11`). `docs/adr/0008` argued for that on the grounds
that the lookups are shared state, so an in-process cache would let two
instances behind a load balancer disagree about a slug for a TTL.

That argument is sound for a multi-instance deploy and beside the point for
everyone else. The cost as it stands is that a single-process install — which
is what `docker compose up` and `bun run dev` both are — cannot start at all
without standing up a second piece of infrastructure whose only job is to hold
data that is regenerable in one query.

The outcome: two interchangeable backends behind the `Cache` seam that already
exists. A `bun:sqlite` in-memory store is the default; Redis is there for anyone
who wants it, for any reason they like. Nothing in the redirect, the
invalidation call sites, or the Hono context changes — `apps/server/src/http/app.ts:31-32`
already says the wrapper exists so no route can be broken "whichever
implementation it was handed", and this is that implementation arriving.

## Decisions taken with the user

- **The SQLite cache is in memory only** — `new Database(":memory:")`. No file,
  no path setting, no volume. This sidesteps `docs/adr/0005` entirely: there is
  no regenerable file to keep out of the durable `/data` volume, and no
  `-wal`/`-shm` sidecars to check-point on shutdown.
- **`LINQ_CACHE_BACKEND` selects the backend explicitly** — `sqlite`, `redis`
  or `none`.
- **A configured Redis must be a reachable Redis.** `LINQ_CACHE_BACKEND=redis`
  with an unreachable server still fails the boot, exactly as today. Falling
  back silently would leave one instance's invalidations invisible to the rest.
- **The docs recommend neither.** Redis on a single instance is a perfectly good
  choice and the documentation should not imply otherwise. `.env.example`,
  `README.md` and `docker-compose.example.yml` describe both and prescribe
  neither; the compose service is present but commented, ready to uncomment.

### How the two settings relate

`LINQ_CACHE_BACKEND` is the explicit switch, and its **default is derived**:

| Configuration | Backend | Why |
|---|---|---|
| nothing set | `sqlite` | The zero-config default. |
| `LINQ_REDIS_URL` set | `redis` | Supplying the URL is what makes Redis expected to exist. |
| `LINQ_CACHE_BACKEND=redis`, no URL | **boot error** | Names a backend it cannot reach. |
| `LINQ_CACHE_BACKEND=sqlite` + a URL set | `sqlite` | The explicit setting wins; no error, so the URL can be left in `.env` while toggling. |
| `LINQ_CACHE_BACKEND=none` | no cache | `noCache`, already written (`cache.ts:21-26`). |

This is the one place the plan goes past the literal answer given: the setting
is explicit, as asked, but leaving it unset and supplying a Redis URL still
selects Redis, so that "if the URL is provided we expect Redis to exist" holds
without anyone having to set two things to mean one.

`LINQ_CACHE_BACKEND=none` also **replaces `LINQ_CACHE_TTL=0`** as the way to
turn caching off. The TTL's minimum becomes 1, and the `if (ttl > 0)` guard in
`startCache` (`cache.ts:99-101`) goes away — one way to say a thing instead of
two.

## 1. `apps/server/src/cache.ts`

The exported surface is unchanged: `Cache`, `Hit<T>`, `noCache`, `guarded`,
`domainKey`, `targetKey`, `startCache(config)`. Nothing that imports this file
changes. `startCache` becomes a three-line switch over two private builders.

```ts
export async function startCache(config: Config): Promise<Cache> {
  switch (config.LINQ_CACHE_BACKEND) {
    case "none":   return noCache
    case "redis":  return await redisCache(config)
    case "sqlite": return sqliteCache(config)
  }
}
```

`redisCache` is today's body, moved verbatim minus the TTL-zero guard.

`sqliteCache` is new. One table, three cached statements, and a sweep on a
timer:

```sql
create table cache (
  key        text    primary key,
  value      text    not null,
  expires_at integer not null
) strict;
create index cache_expires_idx on cache (expires_at);
```

- `get` — `select value from cache where key = ? and expires_at > ?` with
  `Date.now()`. A row means a hit, and `JSON.parse` of `"null"` is a cached
  `null`, so negative caching keeps working exactly as the `Hit<T> | null`
  contract describes (`cache.ts:6-11`).
- `set` — `insert … on conflict (key) do update set value = excluded.value,
  expires_at = excluded.expires_at`.
- `del` — a loop over a cached single-key `delete … where key = ?`. `bun:sqlite`
  cannot bind an array to one placeholder, and every call site today passes
  exactly one key, so a loop beats building placeholders and finalising a
  throwaway statement.
- **Eviction** — a `setInterval` sweep, described in §2.
- `stop` — `clearInterval` then `db.close()`. An in-memory database has no
  sidecar files and needs no check-point.

The cap is worth a comment naming what it gives up: under a flood of requests
for random slugs, every 404 writes a negative entry, and eviction by expiry is
FIFO rather than LRU — so the flood's own entries survive while real links get
dropped and re-read from Postgres on their next hit. Memory stays flat, which is
the property that matters; if the churn ever shows up, the fix is a
`last_read_at` column and true LRU, paid for with a write on every read.

Use `db.query()` (compiled and cached, 20 slots) for the four fixed statements,
not `db.prepare()`.

## 2. Expiry

`LINQ_CACHE_TTL` stays **one setting shared by both backends, default 300** —
five minutes. Switching backend changes where an entry lives, never how long it
lives, so the two are comparable and there is one number to reason about.

Redis is handed the TTL and does the rest (`set key value EX ttl`). SQLite has
no such thing as an expiring row, so there the expiry is data the cache writes
and reads itself, in two halves that do different jobs:

**Exact on read.** `set` stores `expires_at = Date.now() + ttl * 1000` as an
integer. `get` is `select value from cache where key = ? and expires_at > ?`
against the current clock, so a lapsed row stops matching the instant it lapses
and reads as a miss. Correctness never waits for anything to clean up after it —
which is what lets the other half be lazy.

**Lazy on reclaim.** Nothing ever reads a key that is not asked for again, so a
`setInterval` of 60s deletes `where expires_at <= ?` and then trims to
`MAX_ENTRIES`, both served by `cache_expires_idx`. This is purely about memory;
skipping a sweep can never serve a stale entry. The timer is `.unref()`'d and
cleared in `stop()`, the same shape as the geo refresh at
`apps/server/src/visits/geo.ts:66-67`.

Two properties worth stating, because they are the ones that could reasonably
have gone the other way:

- **The TTL is absolute, from the write — not sliding.** Refreshing it on each
  read would mean a write per cache *hit*, which is the cost the cache exists to
  avoid, and a permanently hot key would then never re-read a row that changed
  in the database behind the API's back.
- **Negative entries expire on the same five minutes.** Creating a link or a
  domain already clears the negative entry for that slug or host outright
  (`api/links.ts`, `api/domains.ts`), so a newly created link never waits the
  TTL out. The five minutes only ever applies to a slug that genuinely does not
  exist.

As in Plan_11, the TTL remains a backstop rather than the invalidation
mechanism: every create, update, archive and purge clears its own key, and the
expiry is what covers the cases nothing computed a key for.

## 3. `apps/server/src/config.ts`

```ts
LINQ_REDIS_URL: z.string().min(1).optional(),
LINQ_CACHE_BACKEND: z.enum(["sqlite", "redis", "none"]).optional(),
LINQ_CACHE_TTL: z.coerce.number().int().min(1).default(300),
```

The derived default joins the existing `.transform` block (`config.ts:37-41`),
next to `LINQ_LOG_FILE` and `LINQ_GEO_DIR`, which already establishes the
pattern of one setting defaulting off another:

```ts
LINQ_CACHE_BACKEND: c.LINQ_CACHE_BACKEND ?? (c.LINQ_REDIS_URL ? "redis" : "sqlite"),
```

A `.superRefine` before the transform rejects `LINQ_CACHE_BACKEND=redis` with no
`LINQ_REDIS_URL`; `loadConfig` already prints issues and exits (`config.ts:46-55`).

`apps/server/src/log.ts:63-64` feeds `LINQ_REDIS_URL` to `collectSecrets`. The
`values` list already skips falsy entries, and the `new URL(dsn)` loop is inside
a `try`, so an absent URL is safe today — but filter it out rather than relying
on the `catch`, since the `catch` is there to document a different case.

## 4. Tests

- **`apps/server/test/cache.test.ts` drops its `fakeCache()`** (`:11-27`) and
  runs the whole existing suite — read-through, negative caching, and all eight
  invalidation cases — against the real in-memory SQLite backend from
  `startCache`. A hand-written `Map` standing in for the cache stops being
  necessary the moment the real thing needs no external service, and this is the
  first time the shipped implementation is under test at all. The two
  assertions that peek at `cache.store` become `await cache.get(key)`.
- **A new backend suite** covering what the redirect cannot reach: a value round
  trips; a cached `null` is distinguishable from a miss; `del` removes one key
  and leaves its neighbours.
- **Expiry gets its own cases**, since §2 splits it in two and each half can
  break on its own:
  - *Exact on read* — with `LINQ_CACHE_TTL: 1`, a key written and read back
    immediately hits, and after ~1.1s reads as a miss **with no sweep having
    run**. This is the one real wait in the suite now that the TTL minimum is 1
    second; it should be commented as the slowest test in the file.
  - *Lazy on reclaim* — the row is still physically there right after it
    lapses, and gone once the sweep has run. Driving this off the 60s timer
    would be absurd in a test, so the sweep goes in a named function the suite
    can call directly rather than only being an anonymous `setInterval` body.
  - *The cap holds* — writing `MAX_ENTRIES + n` unexpired keys and sweeping
    leaves the table at the cap, not above it.
- **The degradation block** (`cache.test.ts:182-199`) gains a case that closes
  the SQLite database underneath a live cache, so the failure `guarded` swallows
  is a real one from the real backend rather than a hand-thrown error.
- **`apps/server/test/helpers/db.ts:23-24`** — `LINQ_REDIS_URL: undefined`,
  `LINQ_CACHE_BACKEND: "sqlite"`. The harness still defaults to `noCache`
  (`helpers/app.ts:53`), so no other suite changes.

## 5. Documentation

- **`docs/adr/0009-the-cache-backend-is-a-choice.md`** — supersedes 0008's
  requirement. It should say what the two backends differ in and stop there: the
  in-memory store is per-process, so invalidations reach only the process that
  made them and a second instance can serve a stale entry until the TTL; Redis
  is shared, and if its URL is configured it must be reachable or the server
  will not start. No recommendation either way.
- **`docs/adr/0008`** — a `Superseded by 0009` line on its status, following the
  in-place amendment `docs/adr/0002` already uses. Its reasoning stays as
  written; it is still the argument for choosing Redis.
- **`README.md`** — Redis leaves the hard prerequisites at `:14-17`; `:43`
  (`"Those two are the only required values"`), `:134` and `:213` lose it.
  Postgres stays required. `:205-208` ("where things are written") needs no
  change, which is the point of an in-memory cache.
- **`.env.example`** — `LINQ_CACHE_BACKEND` documented and commented out,
  `LINQ_REDIS_URL` commented out. The `LINQ_CACHE_TTL` note at `:9-12` loses
  "while leaving Redis required" and gains the two facts that are not obvious
  from the number alone: it is five minutes, and it means the same thing on
  either backend.
- **`docker-compose.example.yml`** — the `redis` service, the `depends_on`
  condition and `LINQ_REDIS_URL` all commented, with one line saying that
  uncommenting them switches the cache to Redis. The header at `:1` goes back to
  naming only Postgres as never being inside the image.

Not touched, and worth stating: `main.ts`, `http/app.ts`, `http/env.ts`,
`http/redirect.ts`, and every invalidation call site in `api/links.ts`,
`api/domains.ts` and `api/rules.ts`. `startCache` keeps its signature and
`guarded` already wraps whatever it returns.

## Verification

1. `bun run typecheck`, `bunx biome check .`, `bun test` — the full suite, which
   now exercises the SQLite backend through every redirect and invalidation case
   in `cache.test.ts` rather than through a stand-in.
2. **The default path boots with nothing but Postgres.** With `LINQ_REDIS_URL`
   removed from `.env`, `bun run dev` starts and logs the backend it chose. Hit a
   slug twice at `LINQ_LOG_LEVEL=debug`: the second hit shows no
   `link.findActive` span. Edit the link through the API and hit it again: the
   new destination is served immediately, not after the TTL.
3. **The Redis path still works and still refuses to start when it cannot.**
   With `LINQ_REDIS_URL` set and Redis up, repeat the two checks above and
   confirm `redis-cli keys 'linq:*'` shows both keys. Stop Redis and restart the
   server: it must exit rather than quietly serve from SQLite.
4. **The TTL actually expires things.** With `LINQ_CACHE_TTL=5`, warm a slug,
   change its destination straight in Postgres (`update links set destination
   = …`, bypassing the API so nothing invalidates), and confirm the old
   destination is served for about five seconds and the new one after. Repeat
   on both backends: the same number has to mean the same thing on each.
5. **The mismatch is caught.** `LINQ_CACHE_BACKEND=redis` with no URL exits at
   boot naming the missing setting. `LINQ_CACHE_BACKEND=none` boots and serves
   with no caching at all.
6. **Memory stays flat under a slug flood.** `for i in $(seq 1 60000); do curl
   -s -o /dev/null localhost:3000/$RANDOM$RANDOM; done`, then confirm the cache
   table settles at the cap rather than growing with the request count.
