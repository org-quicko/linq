import type { Cache, Hit } from "@linq/shared"

/** What runs when caching is switched off, and what the test harness defaults to. */
export class NoopCacheAdapter implements Cache {
  async get<T>(_key: string): Promise<Hit<T> | null> {
    return null
  }

  async set(_key: string, _value: unknown): Promise<void> {}

  async del(..._keys: string[]): Promise<void> {}

  stop(): void {}
}
