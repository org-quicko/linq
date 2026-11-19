import type { Cache, Hit } from "@linq/shared"
import { LRUCache } from "lru-cache"
import type { Config } from "../../config.ts"
import { Logger } from "../../libs/index.ts"

/**
 * An in-process store, so nothing outside linq has to be running.
 *
 * It is per-process by definition: invalidations reach only the process that
 * made them, which is the whole of the difference from Redis. See resources/docs/adr/0009.
 */
export class MemoryCacheAdapter implements Cache {
  private readonly store: LRUCache<string, Hit<unknown>>
  private readonly sweep: ReturnType<typeof setInterval>

  /**
   * @param config - TTL, entry cap and sweep interval.
   */
  constructor(
    config: Pick<Config, "LINQ_CACHE_TTL" | "LINQ_CACHE_MAX_ENTRIES" | "LINQ_CACHE_SWEEP_INTERVAL">,
  ) {
    const ttl = config.LINQ_CACHE_TTL
    const max = config.LINQ_CACHE_MAX_ENTRIES
    const sweepMs = config.LINQ_CACHE_SWEEP_INTERVAL * 1000

    // The entry is stored as the `Hit` wrapper rather than the value itself, so a
    // cached `null` is still a real object: lru-cache refuses a nullish value, and
    // the wrapper is the shape `get` has to return anyway.
    //
    // `updateAgeOnGet` stays off, so the TTL runs from the write and never slides.
    // Refreshing it on read would cost a write per cache *hit*, and a permanently
    // hot key would then never re-read a row that changed behind the API's back.
    this.store = new LRUCache<string, Hit<unknown>>({
      max,
      ttl: ttl * 1000,
      updateAgeOnGet: false,
    })

    // lru-cache never removes stale entries on its own: they keep their slot and
    // keep counting toward `max`, so a store full of lapsed keys evicts live ones.
    // Expiry is already checked on access, so this changes no answer — only how
    // long a dead entry occupies a slot.
    //
    // The sweep interval is an independent operational setting: TTL decides when
    // an entry stops answering, while this decides how long that dead entry may
    // continue occupying a slot.
    //
    // One timer for the whole store, not `ttlAutopurge`: that arms a timeout per
    // cached entry, up to `max` of them, and pays a clearTimeout + setTimeout on
    // every write — which is the redirect's miss path.
    this.sweep = setInterval(() => this.store.purgeStale(), sweepMs)
    // The sweep must never be the reason the process stays alive.
    this.sweep.unref?.()

    Logger.info({ backend: "memory", ttl, max, sweepMs }, "cache: ready")
  }

  /** Entries held, lapsed ones included until a sweep. For tests and debugging. */
  size(): number {
    return this.store.size
  }

  async get<T>(key: string): Promise<Hit<T> | null> {
    // Expiry is checked on access, so an entry reads as a miss the instant it
    // lapses, whether or not anything has evicted it yet.
    return (this.store.get(key) as Hit<T> | undefined) ?? null
  }

  async set(key: string, value: unknown): Promise<void> {
    // No serialisation: the value never leaves this process. That relies on
    // nothing mutating a cached object — the redirect only ever reads one.
    this.store.set(key, { value })
  }

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) this.store.delete(key)
  }

  stop(): void {
    clearInterval(this.sweep)
    this.store.clear()
  }
}
