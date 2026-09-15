import { beforeAll, describe, expect, test } from "bun:test"
import { desc, eq, isNull } from "drizzle-orm"
import { flushClicks } from "../src/clicks/record.ts"
import { clicks } from "../src/db/schema.ts"
import { createHarness, type Harness } from "./helpers/app.ts"

const HOST = "links.test"
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile"
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120"
const BOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"

let h: Harness
let author: { userId: string; key: string }
let domain: string

/** The redirect never awaits its insert, so tests drain it before asserting. */
async function lastClick() {
  await flushClicks()
  const [row] = await h.db.select().from(clicks).orderBy(desc(clicks.id)).limit(1)
  return row
}

/** Total rows in `clicks`, drained first so nothing is still in flight. */
async function clickCount() {
  await flushClicks()
  return (await h.db.select().from(clicks)).length
}

beforeAll(async () => {
  h = await createHarness()
  author = await h.actor("author")
  domain = await h.createDomain(HOST, "https://example.com/fallback")
})

const get = (path: string, init: RequestInit & { host?: string } = {}) =>
  h.request(path, { host: HOST, headers: { "user-agent": DESKTOP }, ...init })

describe("domain resolution", () => {
  test("an unknown host is an untracked 404", async () => {
    const before = await clickCount()
    const res = await get("/anything", { host: "nobody.test" })
    expect(res.status).toBe(404)
    expect(await clickCount()).toBe(before)
  })

  test("an archived domain is an untracked 404 for everything", async () => {
    const admin = await h.actor("admin")
    const closed = await h.createDomain("closed.test")
    const linq = await h.createLinq(author.key, closed, { slug: "live" })
    await h.request(`/api/v1/linqs/${linq.id}`, { key: author.key, method: "DELETE" })
    await h.request(`/api/v1/domains/${closed}`, { key: admin.key, method: "DELETE" })

    const before = await clickCount()
    expect((await get("/live", { host: "closed.test" })).status).toBe(404)
    expect((await get("/", { host: "closed.test" })).status).toBe(404)
    expect(await clickCount()).toBe(before)
  })

  test("a row without a port also answers a request carrying one", async () => {
    const linq = await h.createLinq(author.key, domain, { slug: "ported" })
    const res = await get("/ported", { host: `${HOST}:8443` })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(linq.destination)
  })

  test("a row that carries a port matches that host verbatim", async () => {
    const local = await h.createDomain("localhost:3000")
    const linq = await h.createLinq(author.key, local, { slug: "dev" })
    const res = await get("/dev", { host: "localhost:3000" })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(linq.destination)
    expect(linq.shortUrl).toBe("http://localhost:3000/dev")
  })
})

describe("reserved paths", () => {
  test("are answered by linq itself and never tracked", async () => {
    const before = await clickCount()

    // robots.txt is served, /admin normalises to its trailing-slash form, and the
    // rest are simply unclaimed. None of them is a slug.
    const expected: Record<string, number> = {
      "/api": 404,
      "/health": 404,
      "/favicon.ico": 404,
      "/robots.txt": 200,
      "/admin": 302,
    }
    for (const [path, status] of Object.entries(expected)) {
      expect((await get(path)).status).toBe(status)
    }

    expect(await clickCount()).toBe(before)
  })

  test("cover their subpaths, so an API typo never becomes an orphan click", async () => {
    const before = await clickCount()

    // /api/v1/* belongs to the authenticated router, which answers before routing
    // and so does not leak which API paths exist.
    expect((await get("/api/v1/nope")).status).toBe(401)
    expect((await get("/admin/settings")).status).toBe(404)
    // Routing is case-sensitive, so this one does reach the redirect handler.
    expect((await get("/API/v1/nope")).status).toBe(404)

    expect(await clickCount()).toBe(before)
  })

  test("but a deep path that is not reserved is still an orphan", async () => {
    const before = await clickCount()
    const res = await get("/marketing/spring")
    expect(res.status).toBe(302)
    expect(await clickCount()).toBe(before + 1)
    expect(await lastClick()).toMatchObject({ linqId: null, slugRequested: "marketing/spring" })
  })
})

describe("redirecting an active linq", () => {
  test("302s with no-store and records the click", async () => {
    const linq = await h.createLinq(author.key, domain, {
      slug: "hello",
      destination: "https://example.com/landing",
    })

    const res = await get("/hello", {
      headers: { "user-agent": DESKTOP, referer: "https://news.test/post" },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://example.com/landing")
    expect(res.headers.get("cache-control")).toBe("no-store")

    expect(await lastClick()).toMatchObject({
      linqId: linq.id,
      domainId: domain,
      slugRequested: "hello",
      destination: "https://example.com/landing",
      isBot: false,
      platform: "desktop",
      referer: "https://news.test/post",
      country: null,
      region: null,
    })
  })

  test("an archived linq falls through to an orphan click", async () => {
    const linq = await h.createLinq(author.key, domain, { slug: "retired" })
    await h.request(`/api/v1/linqs/${linq.id}`, { key: author.key, method: "DELETE" })

    const res = await get("/retired")
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://example.com/fallback")
    expect(await lastClick()).toMatchObject({ linqId: null, slugRequested: "retired" })
  })
})

describe("orphan clicks", () => {
  test("an unknown slug records the slug asked for and follows the fallback", async () => {
    const res = await get("/never-existed")
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://example.com/fallback")
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await lastClick()).toMatchObject({
      linqId: null,
      slugRequested: "never-existed",
      destination: "https://example.com/fallback",
    })
  })

  test("the root path is an orphan click too", async () => {
    const res = await get("/")
    expect(res.status).toBe(302)
    expect(await lastClick()).toMatchObject({ linqId: null, slugRequested: "" })
  })

  test("a domain with no fallback 404s but still records the orphan", async () => {
    const bare = await h.createDomain("bare.test")
    const res = await get("/missing", { host: "bare.test" })
    expect(res.status).toBe(404)

    await flushClicks()
    const [row] = await h.db
      .select()
      .from(clicks)
      .where(eq(clicks.domainId, bare))
      .orderBy(desc(clicks.id))
      .limit(1)
    expect(row).toMatchObject({ linqId: null, slugRequested: "missing", destination: null })
  })

  test("orphan clicks are the rows with a null linq", async () => {
    await flushClicks()
    const orphans = await h.db.select().from(clicks).where(isNull(clicks.linqId))
    expect(orphans.length).toBeGreaterThan(0)
  })
})

describe("query forwarding", () => {
  test("incoming parameters are merged over the destination and win", async () => {
    await h.createLinq(author.key, domain, {
      slug: "merge",
      destination: "https://example.com/?a=1&keep=yes",
    })

    const res = await get("/merge?a=2&b=3")
    const location = new URL(res.headers.get("location") as string)
    expect(location.searchParams.get("a")).toBe("2")
    expect(location.searchParams.get("b")).toBe("3")
    expect(location.searchParams.get("keep")).toBe("yes")
  })

  test("a repeated incoming key replaces the destination copy entirely", async () => {
    await h.createLinq(author.key, domain, {
      slug: "repeat",
      destination: "https://example.com/?tag=old",
    })

    const res = await get("/repeat?tag=new&tag=newer")
    const location = new URL(res.headers.get("location") as string)
    expect(location.searchParams.getAll("tag")).toEqual(["new", "newer"])
  })

  test("forwardQuery false leaves the destination alone but still logs the query", async () => {
    await h.createLinq(author.key, domain, {
      slug: "sealed",
      destination: "https://example.com/?a=1",
      forwardQuery: false,
    })

    const res = await get("/sealed?b=2")
    expect(res.headers.get("location")).toBe("https://example.com/?a=1")
    expect((await lastClick()).query).toEqual({ b: ["2"] })
  })

  test("a linq with no incoming query keeps its destination byte for byte", async () => {
    await h.createLinq(author.key, domain, {
      slug: "plain",
      destination: "https://example.com/path?x=1#frag",
    })
    const res = await get("/plain")
    expect(res.headers.get("location")).toBe("https://example.com/path?x=1#frag")
    expect((await lastClick()).query).toBeNull()
  })
})

describe("visitor detection", () => {
  test("records the platform each user agent implies", async () => {
    await h.createLinq(author.key, domain, { slug: "ua" })

    for (const [userAgent, platform] of [
      [ANDROID, "android"],
      [IPHONE, "ios"],
      [DESKTOP, "desktop"],
    ] as const) {
      await get("/ua", { headers: { "user-agent": userAgent } })
      expect(await lastClick()).toMatchObject({ platform, isBot: false })
    }
  })

  test("flags bots and a missing user agent", async () => {
    await h.createLinq(author.key, domain, { slug: "crawled" })

    await get("/crawled", { headers: { "user-agent": BOT } })
    expect(await lastClick()).toMatchObject({ isBot: true })

    await h.request("/crawled", { host: HOST })
    expect(await lastClick()).toMatchObject({ isBot: true, userAgent: null })
  })
})

describe("HEAD", () => {
  test("is answered like GET but never tracked", async () => {
    const linq = await h.createLinq(author.key, domain, { slug: "head" })

    const before = await clickCount()
    const res = await get("/head", { method: "HEAD" })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(linq.destination)
    expect(await clickCount()).toBe(before)

    // An orphan HEAD is not tracked either.
    await get("/head-missing", { method: "HEAD" })
    expect(await clickCount()).toBe(before)
  })
})

describe("geo", () => {
  test("stores country and region from the lookup, and never the address", async () => {
    const seen: (string | null)[] = []
    const located = await createHarness({
      geo: {
        lookup: (ip) => {
          seen.push(ip)
          return { country: "IN", region: "Gujarat" }
        },
        stop: () => {},
      },
    })
    const owner = await located.actor("author")
    const host = "geo.test"
    const scoped = await located.createDomain(host)
    await located.createLinq(owner.key, scoped, { slug: "here" })

    const res = await located.request("/here", {
      host,
      headers: { "user-agent": DESKTOP, "x-forwarded-for": "203.0.113.9, 70.41.3.18" },
    })
    expect(res.status).toBe(302)

    await flushClicks()
    const [row] = await located.db.select().from(clicks).limit(1)
    expect(row).toMatchObject({ country: "IN", region: "Gujarat" })
    expect(Object.keys(row)).not.toContain("ip")

    // LINQ_TRUST_PROXY is on, so the first X-Forwarded-For entry is the client.
    expect(seen).toEqual(["203.0.113.9"])
  })

  test("without a licence key every click has an empty location", async () => {
    await h.createLinq(author.key, domain, { slug: "nowhere" })
    await get("/nowhere", { headers: { "user-agent": DESKTOP, "x-forwarded-for": "203.0.113.9" } })
    expect(await lastClick()).toMatchObject({ country: null, region: null })
  })
})
