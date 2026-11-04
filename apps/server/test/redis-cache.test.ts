import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { type Cache, startCache } from "../src/infra/cache.ts"
import { testConfig } from "./helpers/db.ts"

/**
 * The real Redis backend and its Lua script. Skipped unless TEST_REDIS_URL
 * points at a Redis this suite may write to, so `bun run test` still needs
 * nothing running. Every key it writes is under a per-run prefix it deletes.
 */
const url = process.env.TEST_REDIS_URL

describe.skipIf(!url)("the Redis backend", () => {
  const run = `linq-test:${Bun.randomUUIDv7()}`
  const key = (name: string) => `${run}:${name}`
  let cache: Cache
  let raw: RedisClient

  beforeAll(async () => {
    cache = await startCache({ ...testConfig, LINQ_REDIS_URL: url!, LINQ_CACHE_TTL: 60 })
    raw = new RedisClient(url!)
    await raw.connect()
  })

  afterAll(async () => {
    const keys = (await raw.send("KEYS", [`${run}:*`])) as string[]
    if (keys.length) await raw.del(...keys)
    raw.close()
    cache.stop()
  })

  test("a value round trips, a cached null included", async () => {
    await cache.set(key("v"), { nested: ["a", 1] }, 1)
    await cache.set(key("n"), null, 1)
    expect(await cache.get(key("v"))).toEqual({ value: { nested: ["a", 1] } })
    expect(await cache.get(key("n"))).toEqual({ value: null })
    expect(await cache.get(key("absent"))).toBeNull()
  })

  test("the script refuses an older version and accepts an equal or newer one", async () => {
    await cache.set(key("k"), "new", 2_000)
    await cache.set(key("k"), "old", 1_000)
    expect(await cache.get(key("k"))).toEqual({ value: "new" })

    await cache.set(key("k"), "same", 2_000)
    expect(await cache.get(key("k"))).toEqual({ value: "same" })
    await cache.set(key("k"), "newer", 3_000)
    expect(await cache.get(key("k"))).toEqual({ value: "newer" })
  })

  test("every write carries the TTL", async () => {
    await cache.set(key("ttl"), "x", 1)
    const ttl = Number(await raw.send("TTL", [key("ttl")]))
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(60)
  })

  test("an entry that is not in the 2.0 format is overwritten, not trusted", async () => {
    await raw.set(key("legacy"), "not json")
    await cache.set(key("legacy"), "fresh", 1)
    expect(await cache.get(key("legacy"))).toEqual({ value: "fresh" })
  })

  test("del removes one key and leaves its neighbours", async () => {
    await cache.set(key("a"), 1, 1)
    await cache.set(key("b"), 2, 1)
    await cache.del(key("a"))
    expect(await cache.get(key("a"))).toBeNull()
    expect(await cache.get(key("b"))).toEqual({ value: 2 })
  })
})
