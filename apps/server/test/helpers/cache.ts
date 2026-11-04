import type { Cache } from "../../src/infra/cache.ts"

/**
 * An in-process stand-in for the Redis cache, for suites that must run with
 * nothing else running. It keeps the one rule that matters to callers, the
 * versioned write, with the same comparison as the Lua script: an entry is
 * replaced unless it holds a strictly newer version. No TTL: no suite here
 * waits one out.
 *
 * Values are copied through JSON, as Redis copies them, so a test cannot pass
 * by sharing an object the real backend would have serialised.
 */
export function fakeCache(): Cache & { entries: Map<string, { v: number; value: string }> } {
  const entries = new Map<string, { v: number; value: string }>()
  return {
    entries,
    async get(key) {
      const entry = entries.get(key)
      return entry ? { value: JSON.parse(entry.value) } : null
    },
    async set(key, value, version) {
      const current = entries.get(key)
      if (current && current.v > version) return
      entries.set(key, { v: version, value: JSON.stringify(value) })
    },
    async del(...keys) {
      for (const key of keys) entries.delete(key)
    },
    stop: () => entries.clear(),
  }
}
