import { RedisClient as BunRedisClient } from "bun"
import { Logger } from "../libs/index.ts"

/**
 * A connection to one Redis server, and nothing more: it stores strings. What
 * linq keeps there, how values are encoded and how long they live belong to
 * `RedisCacheAdapter`, which is the only caller.
 */
export class RedisClient {
  /**
   * @param connection - An open Bun Redis connection.
   */
  private constructor(private readonly connection: BunRedisClient) {}

  /**
   * Connects, or throws. Not caught: naming a Redis linq cannot reach is a
   * configuration error. See resources/docs/adr/0009.
   *
   * @param url - LINQ_REDIS_URL.
   * @returns The connected client.
   * @throws When Redis cannot be reached.
   */
  static async connect(url: string): Promise<RedisClient> {
    const connection = new BunRedisClient(url)
    connection.onclose = (err) => Logger.error({ err }, "redis: connection closed")
    await connection.connect()
    return new RedisClient(connection)
  }

  /**
   * @param key - The key to read.
   * @returns The stored string, or null when the key is absent.
   */
  get(key: string): Promise<string | null> {
    return this.connection.get(key)
  }

  /**
   * @param key - The key to write.
   * @param value - The string to store.
   * @param ttl - Seconds until the key expires.
   */
  async set(key: string, value: string, ttl: number): Promise<void> {
    await this.connection.set(key, value, "EX", ttl)
  }

  /**
   * @param keys - The keys to delete; none is a no-op.
   */
  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.connection.del(...keys)
  }

  /** Closes the connection. */
  close(): void {
    this.connection.close()
  }
}
