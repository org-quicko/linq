import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Cache } from "../src/libs/cache.ts"
import { domainKey, memoryCache, targetKey, writeThrough } from "../src/libs/cache.ts"
import { createHarness, type Harness } from "./helpers/app.ts"
import { testConfig } from "./helpers/db.ts"

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
 * This is the real in-memory backend, not a stand-in. It needs nothing running
 * outside the process, so there is no reason for the suite to exercise
 * anything other than the code that ships.
 */
beforeEach(async () => {
  cache = memoryCache(testConfig)
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

describe("invalidation and refresh", () => {
  test("creating a link replaces the negative entry for its slug", async () => {
    expect((await get("/fresh")).headers.get("location")).toBe("https://example.com/fallback")
    await h.createLink(editor.key, domain, { slug: "fresh" })
    expect((await get("/fresh")).headers.get("location")).toBe("https://example.com/")
  })

  test("updating a link's destination refreshes its entry", async () => {
    const link = await h.createLink(editor.key, domain, { slug: "moved" })
    await get("/moved")
    await h.patch(`/api/v1/links/${link.id}`, editor.key, {
      destination: "https://example.com/new",
    })
    expect((await get("/moved")).headers.get("location")).toBe("https://example.com/new")
  })

  test("replacing a link's rules refreshes its entry", async () => {
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
    expect((await get("/rules")).headers.get("location")).toBe("https://example.com/desktop")
  })

  test("archiving a link clears its entry, so the slug falls through", async () => {
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

  test("changing a domain's fallback refreshes its entry", async () => {
    await get("/nothing-here")
    await h.patch(`/api/v1/domains/${domain}`, admin.key, {
      fallback_url: "https://example.com/elsewhere",
    })
    expect((await get("/nothing-here")).headers.get("location")).toBe(
      "https://example.com/elsewhere",
    )
  })

  test("archiving a domain clears its entry, so the host stops answering", async () => {
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
 * Write-through, proven the same way as a cache hit: the entry is read straight
 * out of the cache after the write, with no redirect in between to fill it, and
 * where it matters the row is then dropped so only the cache can answer.
 */
describe("write-through", () => {
  const target = async (slug: string) =>
    (await cache.get<{ destination: string; rules: unknown[] } | null>(targetKey(domain, slug)))
      ?.value

  test("an edit writes the new destination before anything reads it", async () => {
    const link = await h.createLink(editor.key, domain, { slug: "edited" })
    await get("/edited")
    await h.patch(`/api/v1/links/${link.id}`, editor.key, {
      destination: "https://example.com/next",
    })
    expect((await target("edited"))?.destination).toBe("https://example.com/next")

    await dropRow(link.id)
    expect((await get("/edited")).headers.get("location")).toBe("https://example.com/next")
  })

  test("a create writes the link over the slug's cached 404", async () => {
    await get("/born")
    expect(await cache.get(targetKey(domain, "born"))).toEqual({ value: null })
    await h.createLink(editor.key, domain, { slug: "born" })
    expect((await target("born"))?.destination).toBe("https://example.com/")
  })

  test("replacing rules writes them into the link's entry", async () => {
    const link = await h.createLink(editor.key, domain, { slug: "ruleset" })
    await h.request(`/api/v1/links/${link.id}/rules`, {
      key: editor.key,
      method: "PUT",
      body: JSON.stringify([
        {
          destination: "https://example.com/ios",
          conditions: [{ type: "platform", value: "ios" }],
        },
      ]),
    })
    expect((await target("ruleset"))?.rules).toHaveLength(1)
  })

  test("archiving through PATCH caches the 404 the slug now gives", async () => {
    const link = await h.createLink(editor.key, domain, { slug: "shelved" })
    await get("/shelved")
    await h.patch(`/api/v1/links/${link.id}`, admin.key, { status: "archived" })
    expect(await cache.get(targetKey(domain, "shelved"))).toEqual({ value: null })
  })

  test("a domain edit writes the new fallback into the host's entry", async () => {
    await h.patch(`/api/v1/domains/${domain}`, admin.key, {
      fallback_url: "https://example.com/written",
    })
    const hit = await cache.get<{ fallback_url: string }>(domainKey(HOST))
    expect(hit?.value.fallback_url).toBe("https://example.com/written")
  })

  test("a domain create writes the domain over the host's cached 404", async () => {
    await h.request("/x", { host: "written.test" })
    await h.post("/api/v1/domains", admin.key, { host: "written.test" })
    const hit = await cache.get<{ id: string } | null>(domainKey("written.test"))
    expect(hit?.value?.id).toBeString()
  })
})

/** The helper on its own, at the failures the routes cannot stage. */
describe("writeThrough", () => {
  test("a set that fails leaves a miss, never the previous answer", async () => {
    const store = memoryCache(testConfig)
    await store.set("k", "old")
    const failingSet: Cache = {
      ...store,
      set: async () => {
        throw new Error("set failed")
      },
    }
    await writeThrough(failingSet, "k", async () => "new").catch(() => {})
    expect(await store.get("k")).toBeNull()
    store.stop()
  })

  test("a load that fails leaves the key cleared and does not throw", async () => {
    const store = memoryCache(testConfig)
    await store.set("k", "old")
    await writeThrough(store, "k", async () => {
      throw new Error("database down")
    })
    expect(await store.get("k")).toBeNull()
    store.stop()
  })

  test("a null answer is written, not skipped", async () => {
    const store = memoryCache(testConfig)
    await writeThrough(store, "k", async () => null)
    expect(await store.get("k")).toEqual({ value: null })
    store.stop()
  })
})

/**
 * The backend on its own, at the level the redirect cannot reach.
 *
 * Expiry is two separate mechanisms — exact on read, lazy on reclaim — and
 * either can break without the other noticing, so each gets its own case.
 */
describe("the memory backend", () => {
  const open = (ttl = 300, max = 10_000, sweepInterval = 60) =>
    memoryCache({
      ...testConfig,
      LINQ_CACHE_TTL: ttl,
      LINQ_CACHE_MAX_ENTRIES: max,
      LINQ_CACHE_SWEEP_INTERVAL: sweepInterval,
    })

  test("a value round trips", async () => {
    const c = open()
    await c.set("k", { nested: ["a", 1] })
    expect(await c.get("k")).toEqual({ value: { nested: ["a", 1] } })
    c.stop()
  })

  test("a cached null is not a miss", async () => {
    const c = open()
    await c.set("k", null)
    expect(await c.get("k")).toEqual({ value: null })
    expect(await c.get("never-written")).toBeNull()
    c.stop()
  })

  test("a second write replaces the value rather than colliding", async () => {
    const c = open()
    await c.set("k", "first")
    await c.set("k", "second")
    expect(await c.get("k")).toEqual({ value: "second" })
    c.stop()
  })

  test("del removes one key and leaves its neighbours", async () => {
    const c = open()
    await c.set("a", 1)
    await c.set("b", 2)
    await c.del("a")
    expect(await c.get("a")).toBeNull()
    expect(await c.get("b")).toEqual({ value: 2 })
    c.stop()
  })

  /** The slowest test in the file, and the only one that waits on real time. */
  test("an entry past its TTL reads as a miss, with no sweep run", async () => {
    const c = open(1)
    await c.set("k", "value")
    expect(await c.get("k")).toEqual({ value: "value" })

    await Bun.sleep(1100)
    expect(await c.get("k")).toBeNull()
    c.stop()
  })

  /**
   * Lapsed entries keep their slot and keep counting toward `max`, so a store
   * full of them evicts live ones. `size` counts them until something reclaims
   * them, so with no sweep this would still read 2.
   *
   * Neither key is read: a read reclaims on access and would prove nothing. The
   * A two-second sweep proves reclamation follows its own setting rather than
   * the one-second TTL.
   */
  test("the sweep reclaims lapsed entries nothing has touched", async () => {
    const c = open(1, 10_000, 2)
    await c.set("a", 1)
    await c.set("b", 2)
    expect(c.size()).toBe(2)

    await Bun.sleep(1200)
    expect(c.size()).toBe(2)

    await Bun.sleep(1000)
    expect(c.size()).toBe(0)
    c.stop()
  })

  test("the cap evicts, so a flood cannot grow the store without limit", async () => {
    const c = open(300, 3)
    for (const k of ["a", "b", "c", "d"]) await c.set(k, k)

    expect(await c.get("a")).toBeNull()
    expect(await c.get("d")).toEqual({ value: "d" })
    c.stop()
  })

  /**
   * The difference between an LRU and the eviction-by-expiry it replaced: under
   * one uniform TTL that was first-in-first-out, so a read could not save an
   * entry. This is the case that would have failed before.
   */
  test("reading an entry saves it from the next eviction", async () => {
    const c = open(300, 3)
    for (const k of ["a", "b", "c"]) await c.set(k, k)

    await c.get("a")
    await c.set("d", "d")

    expect(await c.get("a")).toEqual({ value: "a" })
    expect(await c.get("b")).toBeNull()
    c.stop()
  })

  test("stop empties the store", async () => {
    const c = open()
    await c.set("k", "value")
    c.stop()
    expect(await c.get("k")).toBeNull()
  })
})

/**
 * The test that justifies the whole expiry-in-cache design: nothing ever
 * mutates the row after the link is created, so the *only* way a second hit
 * can fall back after the row's `expires_at` passes is if the timestamp rode
 * inside the cached value and was compared at read time.
 */
describe("expiry inside the cache", () => {
  test("a warm entry still expires on schedule, though the row is never touched", async () => {
    const link = await h.createLink(editor.key, domain, {
      slug: "ticking",
      expires_at: new Date(Date.now() + 50).toISOString(),
    })
    expect((await get("/ticking")).headers.get("location")).toBe(link.destination)

    await Bun.sleep(60)
    const res = await get("/ticking")
    expect(res.headers.get("location")).toBe("https://example.com/fallback")
  })

  test("clearing expires_at to null resolves immediately, proving the write reached the key", async () => {
    const link = await h.createLink(editor.key, domain, {
      slug: "reprieved",
      expires_at: new Date(Date.now() + 50).toISOString(),
    })
    await get("/reprieved")
    await h.patch(`/api/v1/links/${link.id}`, editor.key, { expires_at: null })
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
