/**
 * A cached entry, distinct from a miss: `get` returns `null` when the key is not
 * cached, and `{ value: null }` when the cached answer *is* "there is no such
 * thing". Negative caching is the point — a flood of 404s must cost one query
 * per TTL, not one per request.
 */
export type Hit<T> = { value: T }

/** The cache port: what every service reads and clears. One adapter per backend. */
export interface Cache {
  get<T>(key: string): Promise<Hit<T> | null>
  set(key: string, value: unknown): Promise<void>
  del(...keys: string[]): Promise<void>
  stop(): void
}
