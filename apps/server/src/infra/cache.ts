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

/**
 * A value with the version of the row it was built from: the row's
 * `updated_at` in epoch milliseconds, or 0 when there is no row. See `set`.
 */
export type Versioned<T> = { value: T; version: number }

export type Cache = {
  get<T>(key: string): Promise<Hit<T> | null>
  /**
   * Writes `value` unless the key already holds a newer version, so two
   * writers that finish out of order can never leave the older answer cached.
   * Equal versions overwrite. See resources/docs/adr/0024.
   */
  set(key: string, value: unknown, version: number): Promise<void>
  del(...keys: string[]): Promise<void>
  stop(): void
}

/** What the test harness defaults to: every lookup goes to Postgres. */
export const noCache: Cache = {
  get: async () => null,
  set: async () => {},
  del: async () => {},
  stop: () => {},
}

/**
 * Every key carries a format generation, bumped whenever the stored shape
 * changes. 2.0 began storing `{ v, value }`; a 1.x entry left in Redis is
 * simply never read and lapses on its TTL.
 */
const PREFIX = "linq:2"

/**
 * The domain a host resolves to. Keyed on the host exactly as the request sent
 * it, lowercased, because `findActiveDomain` prefers an exact match over the
 * port-stripped one and the two can be different rows.
 *
 * A domain row without a port that answered a request *with* one is cached under
 * a key no mutation can compute, so that variant is cleared by the TTL rather
 * than by a write. Every host linq is actually configured for updates
 * immediately.
 */
export const domainKey = (host: string): string => `${PREFIX}:domain:${host.trim().toLowerCase()}`

/** The whole redirect answer for one slug on one domain: link, rules and all. */
export const targetKey = (domain_id: string, slug: string): string =>
  `${PREFIX}:target:${domain_id}:${slug}`

/** The whole rendered /llms.txt for one domain. Built from many rows, so it
 *  has no single version: it is deleted on write, never written through. */
export const llmsKey = (domain_id: string): string => `${PREFIX}:llms:${domain_id}`

/**
 * Write-through: replaces a key's entry with what `load` builds now, instead
 * of deleting it and leaving the next request to miss. A failed load falls
 * back to deleting, so a write never leaves an entry it knows to be stale.
 */
export async function writeThrough(
  cache: Cache,
  key: string,
  load: () => Promise<Versioned<unknown>>,
): Promise<void> {
  let fresh: Versioned<unknown>
  try {
    fresh = await load()
  } catch (err) {
    reqLog().error({ err, key }, "cache write-through load failed; invalidating")
    await cache.del(key)
    return
  }
  await cache.set(key, fresh.value, fresh.version)
}

/**
 * Makes a cache unable to fail its caller.
 *
 * A read that throws is a miss, and a write or a delete that throws is covered
 * by the TTL. This wraps at the seam rather than inside the backend, so the
 * guarantee holds for a Redis that was reachable at boot and is not any more.
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
    async set(key, value, version) {
      try {
        await cache.set(key, value, version)
      } catch (err) {
        // Error, not debug: a write-through that fails leaves the old entry
        // behind until the TTL.
        reqLog().error({ err, key }, "cache write failed")
      }
    },
    async del(...keys) {
      try {
        await cache.del(...keys)
      } catch (err) {
        reqLog().error({ err, keys }, "cache invalidation failed")
      }
    },
    stop: () => cache.stop(),
  }
}

/**
 * The version check and the write in one atomic step, so it holds across every
 * linq process sharing this Redis. KEYS[1] the key; ARGV the encoded entry, its
 * version and the TTL in seconds. An entry that does not decode is overwritten.
 */
const SET_IF_NEWER = `
local current = redis.call('GET', KEYS[1])
if current then
  local ok, entry = pcall(cjson.decode, current)
  if ok and type(entry) == 'table' and tonumber(entry.v) and tonumber(entry.v) > tonumber(ARGV[2]) then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
return 1
`

/**
 * Opens the Redis cache. Required, and required to be reachable: naming a
 * Redis linq cannot reach is a configuration error, not something to paper
 * over. A Redis that dies after boot degrades to Postgres through `guarded`.
 * See resources/docs/adr/0024.
 */
export async function startCache(config: Config): Promise<Cache> {
  const client = new RedisClient(config.LINQ_REDIS_URL)
  const ttl = config.LINQ_CACHE_TTL

  client.onclose = (err) => log.error({ err }, "cache: connection closed")
  await client.connect()
  log.info({ backend: "redis", ttl }, "cache: ready")

  return {
    async get(key) {
      const raw = await client.get(key)
      if (raw === null) return null
      const entry = JSON.parse(raw) as { v: number; value: unknown }
      return { value: entry.value } as never
    },
    async set(key, value, version) {
      await client.send("EVAL", [
        SET_IF_NEWER,
        "1",
        key,
        JSON.stringify({ v: version, value }),
        String(version),
        String(ttl),
      ])
    },
    async del(...keys) {
      if (keys.length) await client.del(...keys)
    },
    stop: () => client.close(),
  }
}
