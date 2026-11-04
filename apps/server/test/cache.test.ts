import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import type { Cache } from "../src/infra/cache.ts"
import { domainKey, targetKey } from "../src/infra/cache.ts"
import { createHarness, type Harness } from "./helpers/app.ts"
import { fakeCache } from "./helpers/cache.ts"

const HOST = "cache.test"
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120"

let h: Harness
let cache: Cache
let editor: { keyId: string; key: string }
let admin: { keyId: string; key: string }
let domain: string

/**
 * A fresh harness and a fresh cache per test: the cache is shared mutable
 * state, so a leftover entry from one case would silently satisfy the next.
 *
 * The in-process fake keeps the Redis backend's versioned-write rule, so the
 * suite runs with nothing else running. The Redis backend itself is covered
 * by redis-cache.test.ts.
 */
beforeEach(async () => {
  cache = fakeCache()
  h = await createHarness({ cache })
  editor = await h.actor("editor")
  admin = await h.actor("admin")
  domain = await h.createDomain(HOST, "https://example.com/fallback")
})

afterEach(() => cache.stop())

const get = (path: string) => h.request(path, { host: HOST, headers: { "user-agent": UA } })

/**
 * Deletes the link row behind the API's back. Anything that still redirects
 * afterwards can only have been answered from the cache — which is a sharper
 * proof than counting queries, and needs no spy.
 */
const dropRow = (id: string) => h.db.deleteFrom("links").where("id", "=", id).execute()

describe("reads", () => {
  test("a second hit is answered without the database", async () => {
    const link = await h.createLink(editor.key, domain, { slug: "warm" })
    expect((await get("/warm")).headers.get("location")).toBe("https://example.com/")

    await dropRow(link.id)
    const again = await get("/warm")
    expect(again.status).toBe(302)
    expect(again.headers.get("location")).toBe("https://example.com/")
  })

  test("rules are cached with the link, not looked up again", async () => {
    const link = await h.createLink(editor.key, domain, { slug: "ruled" })
    await h.request(`/api/v1/links/${link.id}/rules`, {
      key: editor.key,
      method: "PUT",
      body: JSON.stringify([
        {
          destination: "https://example.com/android",
          conditions: [{ type: "platform", value: "android" }],
        },
      ]),
    })
    // Warms the entry, then removes the link: the rule can only come from cache.
    await get("/ruled")
    await dropRow(link.id)

    const res = await h.request("/ruled", {
      host: HOST,
      headers: { "user-agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8)" },
    })
    expect(res.headers.get("location")).toBe("https://example.com/android")
  })

  test("an unknown slug is cached as a miss, not re-queried", async () => {
    expect((await get("/ghost")).headers.get("location")).toBe("https://example.com/fallback")
    expect(await cache.get(targetKey(domain, "ghost"))).toEqual({ value: null })
  })

  test("an unknown host is cached as a miss", async () => {
    expect((await h.request("/x", { host: "nobody.test" })).status).toBe(404)
    expect(await cache.get(domainKey("nobody.test"))).toEqual({ value: null })
  })

  test("HEAD reads through the same entry as GET", async () => {
    const link = await h.createLink(editor.key, domain, { slug: "peek" })
    await h.request("/peek", { host: HOST, method: "HEAD" })
    await dropRow(link.id)
    expect((await get("/peek")).headers.get("location")).toBe("https://example.com/")
  })
})

describe("writes", () => {
  test("creating a link replaces the negative entry for its slug", async () => {
    expect((await get("/fresh")).headers.get("location")).toBe("https://example.com/fallback")
    await h.createLink(editor.key, domain, { slug: "fresh" })
    expect((await get("/fresh")).headers.get("location")).toBe("https://example.com/")
  })

  /**
   * Write-through, not invalidation: the row is gone before the next request,
   * so the new destination can only have come from an entry the write itself
   * put in the cache.
   */
  test("updating a link writes its new entry through", async () => {
    const link = await h.createLink(editor.key, domain, { slug: "moved" })
    await get("/moved")
    await h.patch(`/api/v1/links/${link.id}`, editor.key, {
      destination: "https://example.com/new",
    })
    await dropRow(link.id)
    expect((await get("/moved")).headers.get("location")).toBe("https://example.com/new")
  })

  test("a slower read finishing after an edit cannot put the old entry back", async () => {
    const link = await h.createLink(editor.key, domain, { slug: "raced" })
    const key = targetKey(domain, "raced")
    const before = await cache.get(key)
    await h.patch(`/api/v1/links/${link.id}`, editor.key, {
      destination: "https://example.com/after",
    })
    // What a redirect that read the row before the edit would write: the old
    // value, under the old version.
    await cache.set(key, before?.value, new Date(link.updated_at).getTime())
    expect((await get("/raced")).headers.get("location")).toBe("https://example.com/after")
  })

  test("replacing a link's rules writes its entry through", async () => {
    const link = await h.createLink(editor.key, domain, { slug: "rules" })
    await get("/rules")
    await h.request(`/api/v1/links/${link.id}/rules`, {
      key: editor.key,
      method: "PUT",
      body: JSON.stringify([
        {
          destination: "https://example.com/desktop",
          conditions: [{ type: "platform", value: "desktop" }],
        },
      ]),
    })
    await dropRow(link.id)
    expect((await get("/rules")).headers.get("location")).toBe("https://example.com/desktop")
  })

  test("archiving a link writes a miss through, so the slug falls through", async () => {
    const link = await h.createLink(editor.key, domain, { slug: "gone" })
    await get("/gone")
    await h.request(`/api/v1/links/${link.id}`, { key: admin.key, method: "DELETE" })
    expect((await get("/gone")).headers.get("location")).toBe("https://example.com/fallback")
  })

  test("purging a link clears its entry", async () => {
    const link = await h.createLink(editor.key, domain, { slug: "purged" })
    await get("/purged")
    await h.request(`/api/v1/links/${link.id}`, { key: admin.key, method: "DELETE" })
    await h.request(`/api/v1/links/${link.id}/purge`, { key: admin.key, method: "DELETE" })
    expect(await cache.get(targetKey(domain, "purged"))).toBeNull()
  })

  test("changing a domain's fallback writes its entry through", async () => {
    await get("/nothing-here")
    await h.patch(`/api/v1/domains/${domain}`, admin.key, {
      fallback_url: "https://example.com/elsewhere",
    })
    expect((await get("/nothing-here")).headers.get("location")).toBe(
      "https://example.com/elsewhere",
    )
  })

  test("archiving a domain writes a miss through, so the host stops answering", async () => {
    await get("/nothing-here")
    await h.request(`/api/v1/domains/${domain}`, { key: admin.key, method: "DELETE" })
    expect((await get("/nothing-here")).status).toBe(404)
  })

  test("creating a domain replaces the negative entry for its host", async () => {
    expect((await h.request("/x", { host: "later.test" })).status).toBe(404)
    await h.post("/api/v1/domains", admin.key, {
      host: "later.test",
      fallback_url: "https://example.com/later",
    })
    const res = await h.request("/x", { host: "later.test" })
    expect(res.headers.get("location")).toBe("https://example.com/later")
  })
})

/**
 * The versioned write on its own, through the fake. The same comparison runs
 * in the Redis backend's Lua script; redis-cache.test.ts checks it there.
 */
describe("versioned writes", () => {
  test("a value round trips, a cached null included", async () => {
    const c = fakeCache()
    await c.set("k", { nested: ["a", 1] }, 1)
    await c.set("n", null, 1)
    expect(await c.get("k")).toEqual({ value: { nested: ["a", 1] } })
    expect(await c.get("n")).toEqual({ value: null })
    expect(await c.get("never-written")).toBeNull()
  })

  test("an older version never replaces a newer one", async () => {
    const c = fakeCache()
    await c.set("k", "new", 2)
    await c.set("k", "old", 1)
    expect(await c.get("k")).toEqual({ value: "new" })
  })

  test("an equal or newer version replaces", async () => {
    const c = fakeCache()
    await c.set("k", "first", 1)
    await c.set("k", "same", 1)
    expect(await c.get("k")).toEqual({ value: "same" })
    await c.set("k", "newer", 2)
    expect(await c.get("k")).toEqual({ value: "newer" })
  })

  test("a miss cached at version 0 gives way to any real row", async () => {
    const c = fakeCache()
    await c.set("k", null, 0)
    await c.set("k", "created", 1)
    expect(await c.get("k")).toEqual({ value: "created" })
  })
})

/**
 * The test that justifies the whole expiry-in-cache design: nothing ever
 * mutates the row after the link is created, so the *only* way a second hit
 * can fall back after the row's `expires_at` passes is if the timestamp rode
 * inside the cached value and was compared at read time.
 */
describe("expiry inside the cache", () => {
  // The clock is moved, never raced: a real sleep past a short expiry fails
  // whenever creating the link alone outlasts the window, as it does under a
  // loaded full run.
  const HOUR = 60 * 60 * 1000
  const inAnHour = () => new Date(Date.now() + HOUR).toISOString()
  const pastExpiry = () => setSystemTime(new Date(Date.now() + 2 * HOUR))

  afterEach(() => {
    setSystemTime()
  })

  test("a warm entry still expires on schedule, though the row is never touched", async () => {
    const link = await h.createLink(editor.key, domain, { slug: "ticking", expires_at: inAnHour() })
    expect((await get("/ticking")).headers.get("location")).toBe(link.destination)

    pastExpiry()
    const res = await get("/ticking")
    expect(res.headers.get("location")).toBe("https://example.com/fallback")
  })

  test("clearing expires_at to null resolves immediately, proving the write reached the key", async () => {
    const link = await h.createLink(editor.key, domain, { slug: "reprieved", expires_at: inAnHour() })
    await get("/reprieved")
    await h.patch(`/api/v1/links/${link.id}`, editor.key, { expires_at: null })

    // Past the old expiry, a stale entry the write missed would answer the fallback.
    pastExpiry()
    expect((await get("/reprieved")).headers.get("location")).toBe(link.destination)
  })
})

describe("degradation", () => {
  /** A cache is never allowed to fail a request. See resources/docs/adr/0009. */
  const broken: Cache = {
    get: async () => {
      throw new Error("cache is down")
    },
    set: async () => {
      throw new Error("cache is down")
    },
    del: async () => {
      throw new Error("cache is down")
    },
    stop: () => {},
  }

  async function redirectsAnyway(cache: Cache) {
    const down = await createHarness({ cache })
    const who = await down.actor("editor")
    const domain_id = await down.createDomain("down.test")
    const link = await down.createLink(who.key, domain_id, { slug: "still-works" })

    const res = await down.request("/still-works", { host: "down.test" })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://example.com/")

    // And the mutation path, whose invalidation is the call that throws.
    const patched = await down.patch(`/api/v1/links/${link.id}`, who.key, {
      destination: "https://example.com/two",
    })
    expect(patched.status).toBe(200)
  }

  test("a cache that throws on every call still redirects", async () => {
    await redirectsAnyway(broken)
  })
})
