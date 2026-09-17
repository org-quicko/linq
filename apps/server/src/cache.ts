import { Database } from "bun:sqlite"
import { RedisClient } from "bun"
import type { Config } from "./config.ts"
import { log, reqLog } from "./log.ts"

/**
 * A cached entry, distinct from a miss: `get` returns `null` when the key is not
 * cached, and `{ value: null }` when the cached answer *is* "there is no such
 * thing". Negative caching is the point — a flood of 404s must cost one query
 * per TTL, not one per request.
 */
export type Hit<T> = { value: T }

export type Cache = {
  get<T>(key: string): Promise<Hit<T> | null>
  set(key: string, value: unknown): Promise<void>
  del(...keys: string[]): Promise<void>
  stop(): void
}

/** What runs when caching is switched off, and what the test harness defaults to. */
export const noCache: Cache = {
  get: async () => null,
  set: async () => {},
  del: async () => {},
  stop: () => {},
}

/**
 * The domain a host resolves to. Keyed on the host exactly as the request sent
 * it, lowercased, because `findActiveDomain` prefers an exact match over the
 * port-stripped one and the two can be different rows.
 *
 * A domain row without a port that answered a request *with* one is cached under
 * a key no mutation can compute, so that variant is cleared by the TTL rather
 * than by an invalidation. Every host linq is actually configured for clears
 * immediately.
 */
export const domainKey = (host: string): string => `linq:domain:${host.trim().toLowerCase()}`

/** The whole redirect answer for one slug on one domain: link, rules and all. */
export const targetKey = (domainId: string, slug: string): string =>
  `linq:target:${domainId}:${slug}`

/**
 * Makes a cache unable to fail its caller.
 *
 * A read that throws is a miss, and a write or an invalidation that throws is
 * covered by the TTL. This wraps at the seam rather than inside either backend,
 * so the guarantee holds for whichever one the app was handed — including a
 * Redis that was reachable at boot and is not any more.
 */
export function guarded(cache: Cache): Cache {
  return {
    async get(key) {
      try {
        return await cache.get(key)
      } catch (err) {
        // Debug, not error: the query this falls back to is the same one an
        // empty cache would have run.
        reqLog().debug({ err, key }, "cache read failed")
        return null
      }
    },
    async set(key, value) {
      try {
        await cache.set(key, value)
      } catch (err) {
        reqLog().debug({ err, key }, "cache write failed")
      }
    },
    async del(...keys) {
      try {
        await cache.del(...keys)
      } catch (err) {
        // Error, not debug: this one leaves a stale entry behind until the TTL.
        reqLog().error({ err, keys }, "cache invalidation failed")
      }
    },
    stop: () => cache.stop(),
  }
}

/**
 * Opens whichever store the configuration selected.
 *
 * Both backends honour `LINQ_CACHE_TTL` identically, so switching between them
 * changes where an entry lives and nothing about how long. See docs/adr/0009.
 */
export async function startCache(config: Config): Promise<Cache> {
  switch (config.LINQ_CACHE_BACKEND) {
    case "none":
      log.info({ backend: "none" }, "cache: disabled, every lookup hits postgres")
      return noCache
    case "redis":
      return await redisCache(config)
    case "sqlite":
      return sqliteCache(config)
  }
}

/** Shared by every process that points at it, and required to be reachable. */
async function redisCache(config: Config): Promise<Cache> {
  const client = new RedisClient(config.LINQ_REDIS_URL)
  const ttl = config.LINQ_CACHE_TTL

  client.onclose = (err) => log.error({ err }, "cache: connection closed")
  // Not caught: naming a Redis linq cannot reach is a configuration error, and
  // quietly serving from a per-process store instead would hide it. See
  // docs/adr/0009.
  await client.connect()
  log.info({ backend: "redis", ttl }, "cache: ready")

  return {
    async get(key) {
      const raw = await client.get(key)
      return raw === null ? null : { value: JSON.parse(raw) }
    },
    set: async (key, value) => void (await client.set(key, JSON.stringify(value), "EX", ttl)),
    async del(...keys) {
      if (keys.length) await client.del(...keys)
    },
    stop: () => client.close(),
  }
}

/** How often expired rows are reclaimed. Correctness never waits for this. */
const SWEEP_EVERY_MS = 60_000

/**
 * The most rows the table is allowed to hold.
 *
 * Without it a flood of requests for random slugs would grow the table without
 * limit, since every 404 writes a negative entry. Eviction under pressure is by
 * expiry, which under one TTL is first-in-first-out rather than
 * least-recently-used: the flood's own entries are the newest, so they survive
 * while real links get dropped and re-read from Postgres on their next hit.
 * Memory stays flat, which is the property worth having; if that churn ever
 * shows up in practice, the fix is a `last_read_at` column and true LRU, paid
 * for with a write on every read.
 */
export const MAX_ENTRIES = 50_000

/**
 * An in-process store, so nothing outside linq has to be running.
 *
 * It is per-process by definition: invalidations reach only the process that
 * made them, which is the whole of the difference from Redis. See docs/adr/0009.
 */
export function sqliteCache(config: Config): Cache & { sweep: () => number } {
  const ttl = config.LINQ_CACHE_TTL
  const db = new Database(":memory:")

  db.run(`create table cache (
    key        text    primary key,
    value      text    not null,
    expires_at integer not null
  ) strict`)
  db.run("create index cache_expires_idx on cache (expires_at)")

  // `query` compiles once and caches; these four are every statement there is.
  const read = db.query<{ value: string }, [string, number]>(
    "select value from cache where key = ? and expires_at > ?",
  )
  const write = db.query<void, [string, string, number]>(
    `insert into cache (key, value, expires_at) values (?, ?, ?)
     on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at`,
  )
  const drop = db.query<void, [string]>("delete from cache where key = ?")
  const expire = db.query<void, [number]>("delete from cache where expires_at <= ?")
  const trim = db.query<void, [number]>(
    // `max(0, …)` is load-bearing: a negative LIMIT means *no* limit in SQLite,
    // so without it a table under the cap would delete itself entirely.
    `delete from cache where key in (
       select key from cache order by expires_at limit max(0, (select count(*) from cache) - ?)
     )`,
  )
  const size = db.query<{ n: number }, []>("select count(*) as n from cache")

  /**
   * Reclaims what the read path has already stopped returning, and returns how
   * many rows are left. Named rather than written inline in the timer so the
   * tests can drive it without waiting out a minute.
   */
  const sweep = () => {
    expire.run(Date.now())
    trim.run(MAX_ENTRIES)
    return size.get()?.n ?? 0
  }

  const timer = setInterval(sweep, SWEEP_EVERY_MS)
  timer.unref?.()
  log.info({ backend: "sqlite", ttl }, "cache: ready")

  return {
    sweep,
    async get(key) {
      // The expiry is enforced here, against the clock, so an entry reads as a
      // miss the instant it lapses whether or not the sweep has been round.
      const row = read.get(key, Date.now())
      return row ? { value: JSON.parse(row.value) } : null
    },
    async set(key, value) {
      // Absolute from the write, never sliding: refreshing on read would cost a
      // write per cache hit, and a hot key would then never re-read a row that
      // changed in the database behind the API's back.
      write.run(key, JSON.stringify(value), Date.now() + ttl * 1000)
    },
    async del(...keys) {
      // bun:sqlite cannot bind an array to one placeholder, and every call site
      // passes a single key, so a loop beats generating placeholders.
      for (const key of keys) drop.run(key)
    },
    stop: () => {
      clearInterval(timer)
      db.close()
    },
  }
}
