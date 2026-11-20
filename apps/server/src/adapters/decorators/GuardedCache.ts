import type { Cache, Hit } from "@linq/shared"
import { Logger } from "../../libs/index.ts"

/**
 * Makes a cache unable to fail its caller.
 *
 * A read that throws is a miss, and a write or an invalidation that throws is
 * covered by the TTL. A decorator over the port rather than logic inside any
 * adapter, so the guarantee holds for whichever one the app was handed —
 * including a Redis that was reachable at boot and is not any more.
 */
export class GuardedCache implements Cache {
  /**
   * @param cache - The cache to guard.
   */
  constructor(private readonly cache: Cache) {}

  async get<T>(key: string): Promise<Hit<T> | null> {
    try {
      return await this.cache.get<T>(key)
    } catch (err) {
      // Debug, not error: the query this falls back to is the same one an
      // empty cache would have run.
      Logger.forRequest().debug({ err, key }, "cache read failed")
      return null
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    try {
      await this.cache.set(key, value)
    } catch (err) {
      Logger.forRequest().debug({ err, key }, "cache write failed")
    }
  }

  async del(...keys: string[]): Promise<void> {
    try {
      await this.cache.del(...keys)
    } catch (err) {
      // Error, not debug: this one leaves a stale entry behind until the TTL.
      Logger.forRequest().error({ err, keys }, "cache invalidation failed")
    }
  }

  stop(): void {
    this.cache.stop()
  }
}
