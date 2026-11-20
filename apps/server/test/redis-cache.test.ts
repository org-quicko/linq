import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { RedisClient } from "bun"
import { RedisCacheAdapter } from "../src/adapters/index.ts"

afterEach(() => mock.restore())

test("native Redis preserves a cached null separately from a missing key", async () => {
  // Construction is lazy; stub commands so the suite needs no Redis service.
  const client = new RedisClient("redis://127.0.0.1:1")
  const get = spyOn(client, "get").mockResolvedValueOnce(null).mockResolvedValueOnce("null")
  const cache = new RedisCacheAdapter(client, 60)
  try {
    expect(await cache.get("missing")).toBeNull()
    expect(await cache.get("negative")).toEqual({ value: null })
    expect(get).toHaveBeenCalledTimes(2)
  } finally {
    client.close()
  }
})

test("native writes retain atomic expiry and deletion accepts no keys", async () => {
  const client = new RedisClient("redis://127.0.0.1:1")
  const set = spyOn(client, "set").mockResolvedValue("OK")
  const del = spyOn(client, "del").mockResolvedValue(2)
  const cache = new RedisCacheAdapter(client, 45)
  try {
    await cache.set("link", { destination: "https://example.com" })
    expect(set).toHaveBeenCalledWith("link", '{"destination":"https://example.com"}', "EX", 45)
    await cache.del()
    expect(del).not.toHaveBeenCalled()
    await cache.del("link", "domain")
    expect(del).toHaveBeenCalledWith("link", "domain")
  } finally {
    client.close()
  }
})

test("startup propagates a Redis connection failure and closes the client", async () => {
  const failure = new Error("unreachable Redis")
  spyOn(RedisClient.prototype, "connect").mockRejectedValue(failure)
  const close = spyOn(RedisClient.prototype, "close").mockImplementation(() => {})
  await expect(
    RedisCacheAdapter.connect({
      LINQ_REDIS_URL: "redis://127.0.0.1:1",
      LINQ_CACHE_TTL: 60,
    }),
  ).rejects.toBe(failure)
  expect(close).toHaveBeenCalledTimes(1)
})
