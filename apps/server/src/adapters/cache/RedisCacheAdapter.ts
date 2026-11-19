import type { Cache, Hit } from "@linq/shared"
import { RedisClient } from "../../clients/index.ts"
import type { Config } from "../../config.ts"
import { Logger } from "../../libs/index.ts"

/**
 * The cache port over Redis: shared by every process that points at it, and
 * required to be reachable at boot. See resources/docs/adr/0009. Values are
 * stored as JSON; the connection itself is `RedisClient`'s.
 */
export class RedisCacheAdapter implements Cache {
  /**
   * @param client - A connected Redis client.
   * @param ttl - Seconds an entry lives, from its write.
   */
  constructor(
    private readonly client: RedisClient,
    private readonly ttl: number,
  ) {}

  /**
   * Connects a client and wraps it.
   *
   * @param config - LINQ_REDIS_URL and LINQ_CACHE_TTL.
   * @returns The ready adapter.
   * @throws When Redis cannot be reached.
   */
  static async connect(
    config: Pick<Config, "LINQ_REDIS_URL" | "LINQ_CACHE_TTL">,
  ): Promise<RedisCacheAdapter> {
    // `loadConfig` already refuses redis without a URL; this only narrows the type.
    if (!config.LINQ_REDIS_URL) throw new Error("LINQ_REDIS_URL is required for the redis cache")
    const client = await RedisClient.connect(config.LINQ_REDIS_URL)
    Logger.info({ backend: "redis", ttl: config.LINQ_CACHE_TTL }, "cache: ready")
    return new RedisCacheAdapter(client, config.LINQ_CACHE_TTL)
  }

  async get<T>(key: string): Promise<Hit<T> | null> {
    const raw = await this.client.get(key)
    return raw === null ? null : { value: JSON.parse(raw) }
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.client.set(key, JSON.stringify(value), this.ttl)
  }

  async del(...keys: string[]): Promise<void> {
    await this.client.del(...keys)
  }

  stop(): void {
    this.client.close()
  }
}
