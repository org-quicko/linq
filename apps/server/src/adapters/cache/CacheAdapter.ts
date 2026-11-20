import type { Cache } from "@linq/shared"
import type { Config } from "../../config.ts"
import { Logger } from "../../libs/index.ts"
import { MemoryCacheAdapter } from "./MemoryCacheAdapter.ts"
import { NoopCacheAdapter } from "./NoopCacheAdapter.ts"
import { RedisCacheAdapter } from "./RedisCacheAdapter.ts"

/** Opening a cache, and reading through one. */
export class CacheAdapter {
  /**
   * Opens whichever adapter the configuration selected.
   *
   * Both real backends honour `LINQ_CACHE_TTL` identically, so switching between
   * them changes where an entry lives and nothing about how long. A configured
   * Redis must be reachable here, or boot fails. See resources/docs/adr/0009.
   *
   * @param config - LINQ_CACHE_BACKEND and the chosen backend's settings.
   * @returns The opened cache. Not guarded: `createApp` guards it at the seam.
   * @throws When LINQ_CACHE_BACKEND is `redis` and Redis cannot be reached.
   */
  static async start(config: Config): Promise<Cache> {
    switch (config.LINQ_CACHE_BACKEND) {
      case "none":
        Logger.info({ backend: "none" }, "cache: disabled, every lookup hits postgres")
        return new NoopCacheAdapter()
      case "redis":
        return await RedisCacheAdapter.connect(config)
      case "memory":
        return new MemoryCacheAdapter(config)
    }
  }

  /**
   * Reads one key through the cache, falling back to `load` on a miss and writing
   * the answer back — a `null` answer included, so an unknown host or slug costs
   * one query per TTL rather than one per request.
   *
   * @param cache - The cache to read through.
   * @param key - The cache key.
   * @param load - Loads the value on a miss.
   * @returns The cached or freshly loaded value.
   */
  static async readThrough<T>(
    cache: Cache,
    key: string,
    load: () => Promise<T | null>,
  ): Promise<T | null> {
    const hit = await cache.get<T | null>(key)
    if (hit) return hit.value
    const value = await load()
    await cache.set(key, value)
    return value
  }
}
