import { RedisClient } from "bun"
import { LRUCache } from "lru-cache"
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
    case "memory":
      return memoryCache(config)
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

/**
 * An in-process store, so nothing outside linq has to be running.
 *
 * It is per-process by definition: invalidations reach only the process that
 * made them, which is the whole of the difference from Redis. See docs/adr/0009.
 */
export function memoryCache(config: Config): Cache {
  const ttl = config.LINQ_CACHE_TTL
  const max = config.LINQ_CACHE_MAX_ENTRIES

  // The entry is stored as the `Hit` wrapper rather than the value itself, so a
  // cached `null` is still a real object: lru-cache refuses a nullish value, and
  // the wrapper is the shape `get` has to return anyway.
  //
  // `updateAgeOnGet` stays off, so the TTL runs from the write and never slides.
  // Refreshing it on read would cost a write per cache *hit*, and a permanently
  // hot key would then never re-read a row that changed behind the API's back.
  const store = new LRUCache<string, Hit<unknown>>({
    max,
    ttl: ttl * 1000,
    updateAgeOnGet: false,
  })

  log.info({ backend: "memory", ttl, max }, "cache: ready")

  return {
    async get<T>(key: string) {
      // Expiry is checked on access, so an entry reads as a miss the instant it
      // lapses, whether or not anything has evicted it yet.
      return (store.get(key) as Hit<T> | undefined) ?? null
    },
    async set(key, value) {
      // No serialisation: the value never leaves this process. That relies on
      // nothing mutating a cached object — the redirect only ever reads one.
      store.set(key, { value })
    },
    async del(...keys) {
      for (const key of keys) store.delete(key)
    },
    stop: () => store.clear(),
  }
}
