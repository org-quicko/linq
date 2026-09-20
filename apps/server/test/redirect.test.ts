import { beforeAll, describe, expect, test } from "bun:test"
import { desc, eq, isNull } from "drizzle-orm"
import { visits } from "../src/db/schema.ts"
import { flushVisits } from "../src/visits/record.ts"
import { createHarness, type Harness } from "./helpers/app.ts"

const HOST = "links.test"
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile"
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile Safari/605.1.15"
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120"
const BOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"

let h: Harness
let author: { keyId: string; key: string }
let domain: string

/** The redirect never awaits its insert, so tests drain it before asserting. */
async function lastVisit() {
  await flushVisits()
  const [row] = await h.db.select().from(visits).orderBy(desc(visits.id)).limit(1)
  return row
}

/** Total rows in `visits`, drained first so nothing is still in flight. */
async function visitCount() {
  await flushVisits()
  return (await h.db.select().from(visits)).length
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
    const before = await visitCount()
    const res = await get("/anything", { host: "nobody.test" })
    expect(res.status).toBe(404)
    expect(await visitCount()).toBe(before)
  })

  test("an archived domain is an untracked 404 for everything", async () => {
    const admin = await h.actor("admin")
    const closed = await h.createDomain("closed.test")
    const link = await h.createLink(author.key, closed, { slug: "live" })
    await h.request(`/api/v1/links/${link.id}`, { key: author.key, method: "DELETE" })
    await h.request(`/api/v1/domains/${closed}`, { key: admin.key, method: "DELETE" })

    const before = await visitCount()
    expect((await get("/live", { host: "closed.test" })).status).toBe(404)
    expect((await get("/", { host: "closed.test" })).status).toBe(404)
    expect(await visitCount()).toBe(before)
  })

  test("a row without a port also answers a request carrying one", async () => {
    const link = await h.createLink(author.key, domain, { slug: "ported" })
    const res = await get("/ported", { host: `${HOST}:8443` })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(link.destination)
  })

  test("a row that carries a port matches that host verbatim", async () => {
    const local = await h.createDomain("localhost:3000")
    const link = await h.createLink(author.key, local, { slug: "dev" })
    const res = await get("/dev", { host: "localhost:3000" })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(link.destination)
    expect(link.shortUrl).toBe("http://localhost:3000/dev")
  })
})

describe("reserved paths", () => {
  test("are answered by link itself and never tracked", async () => {
    const before = await visitCount()

    // robots.txt is served, /home normalises to its trailing-slash form, and the
    // rest are simply unclaimed. None of them is a slug.
    const expected: Record<string, number> = {
      "/api": 404,
      "/health": 404,
      "/favicon.ico": 404,
      "/robots.txt": 200,
      "/home": 302,
    }
    for (const [path, status] of Object.entries(expected)) {
      expect((await get(path)).status).toBe(status)
    }

    expect(await visitCount()).toBe(before)
  })

  test("cover their subpaths, so an API typo never becomes an orphan visit", async () => {
    const before = await visitCount()

    // /api/v1/* belongs to the authenticated router, which answers before routing
    // and so does not leak which API paths exist.
    expect((await get("/api/v1/nope")).status).toBe(401)
    expect((await get("/home/not-a-page")).status).toBe(404)
    // Routing is case-sensitive, so this one does reach the redirect handler.
    expect((await get("/API/v1/nope")).status).toBe(404)

    expect(await visitCount()).toBe(before)
  })

  test("but a deep path that is not reserved is still an orphan", async () => {
    const before = await visitCount()
    const res = await get("/marketing/spring")
    expect(res.status).toBe(302)
    expect(await visitCount()).toBe(before + 1)
    expect(await lastVisit()).toMatchObject({ linkId: null, slugRequested: "marketing/spring" })
  })
})

describe("redirecting an active link", () => {
  test("302s with no-store and records the visit", async () => {
    const link = await h.createLink(author.key, domain, {
      slug: "hello",
      destination: "https://example.com/landing",
    })

    const res = await get("/hello", {
      headers: { "user-agent": DESKTOP, referer: "https://news.test/post" },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://example.com/landing")
    expect(res.headers.get("cache-control")).toBe("no-store")

    const visit = await lastVisit()
    expect(visit).toMatchObject({
      linkId: link.id,
      domainId: domain,
      slugRequested: "hello",
      destination: "https://example.com/landing",
      isBot: false,
      platform: "desktop",
      referer: "https://news.test/post",
    })
    // The address is never read and never stored. See docs/adr/0001.
    expect(Object.keys(visit)).not.toContain("ip")
  })

  test("an archived link falls through to an orphan visit", async () => {
    const link = await h.createLink(author.key, domain, { slug: "retired" })
    await h.request(`/api/v1/links/${link.id}`, { key: author.key, method: "DELETE" })

    const res = await get("/retired")
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://example.com/fallback")
    expect(await lastVisit()).toMatchObject({ linkId: null, slugRequested: "retired" })
  })
})

describe("orphan visits", () => {
  test("an unknown slug records the slug asked for and follows the fallback", async () => {
    const res = await get("/never-existed")
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://example.com/fallback")
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await lastVisit()).toMatchObject({
      linkId: null,
      slugRequested: "never-existed",
      destination: "https://example.com/fallback",
    })
  })

  test("the root path is an orphan visit too", async () => {
    const res = await get("/")
    expect(res.status).toBe(302)
    expect(await lastVisit()).toMatchObject({ linkId: null, slugRequested: "" })
  })

  test("a domain with no fallback 404s but still records the orphan", async () => {
    const bare = await h.createDomain("bare.test")
    const res = await get("/missing", { host: "bare.test" })
    expect(res.status).toBe(404)

    await flushVisits()
    const [row] = await h.db
      .select()
      .from(visits)
      .where(eq(visits.domainId, bare))
      .orderBy(desc(visits.id))
      .limit(1)
    expect(row).toMatchObject({ linkId: null, slugRequested: "missing", destination: null })
  })

  test("orphan visits are the rows with a null link", async () => {
    await flushVisits()
    const orphans = await h.db.select().from(visits).where(isNull(visits.linkId))
    expect(orphans.length).toBeGreaterThan(0)
  })
})

describe("query forwarding", () => {
  test("incoming parameters are merged over the destination and win", async () => {
    await h.createLink(author.key, domain, {
      slug: "merge",
      destination: "https://example.com/?a=1&keep=yes",
    })

    const res = await get("/merge?a=2&b=3")
    const location = new URL(res.headers.get("location") as string)
    expect(location.searchParams.get("a")).toBe("2")
    expect(location.searchParams.get("b")).toBe("3")
    expect(location.searchParams.get("keep")).toBe("yes")
  })

  test("the recorded destination is the link's own, never the merged one", async () => {
    await h.createLink(author.key, domain, {
      slug: "recorded",
      destination: "https://example.com/?a=1",
      presetParams: { utm_source: "qr" },
    })

    await get("/recorded?ref=newsletter")
    expect((await lastVisit()).destination).toBe("https://example.com/?a=1")

    await get("/recorded?ref=email&utm_source=override")
    expect((await lastVisit()).destination).toBe("https://example.com/?a=1")
  })

  test("a repeated incoming key replaces the destination copy entirely", async () => {
    await h.createLink(author.key, domain, {
      slug: "repeat",
      destination: "https://example.com/?tag=old",
    })

    const res = await get("/repeat?tag=new&tag=newer")
    const location = new URL(res.headers.get("location") as string)
    expect(location.searchParams.getAll("tag")).toEqual(["new", "newer"])
  })

  test("forwardQuery false leaves the destination alone but still logs the query", async () => {
    await h.createLink(author.key, domain, {
      slug: "sealed",
      destination: "https://example.com/?a=1",
      forwardQuery: false,
    })

    const res = await get("/sealed?b=2")
    expect(res.headers.get("location")).toBe("https://example.com/?a=1")
    expect((await lastVisit()).query).toEqual({ b: ["2"] })
  })

  test("a link with no incoming query keeps its destination byte for byte", async () => {
    await h.createLink(author.key, domain, {
      slug: "plain",
      destination: "https://example.com/path?x=1#frag",
    })
    const res = await get("/plain")
    expect(res.headers.get("location")).toBe("https://example.com/path?x=1#frag")
    expect((await lastVisit()).query).toBeNull()
  })
})

describe("preset params", () => {
  test("a preset overrides a forwarded param of the same key", async () => {
    await h.createLink(author.key, domain, {
      slug: "preset-vs-caller",
      destination: "https://example.com/",
      presetParams: { a: "preset" },
    })

    const res = await get("/preset-vs-caller?a=caller")
    const location = new URL(res.headers.get("location") as string)
    expect(location.searchParams.get("a")).toBe("preset")
  })

  test("a preset overrides the destination's own param", async () => {
    await h.createLink(author.key, domain, {
      slug: "preset-vs-dest",
      destination: "https://example.com/?a=dest&keep=dest",
      presetParams: { a: "preset" },
    })

    const res = await get("/preset-vs-dest")
    const location = new URL(res.headers.get("location") as string)
    expect(location.searchParams.get("a")).toBe("preset")
    expect(location.searchParams.get("keep")).toBe("dest")
  })

  test("forwardQuery false leaves the destination untouched even with presets set", async () => {
    await h.createLink(author.key, domain, {
      slug: "preset-sealed",
      destination: "https://example.com/?a=dest&keep=dest",
      presetParams: { a: "preset", utm_source: "qr" },
      forwardQuery: false,
    })

    const res = await get("/preset-sealed?a=caller&c=caller")
    expect(res.headers.get("location")).toBe("https://example.com/?a=dest&keep=dest")
  })

  test("a link with no presets produces a byte-identical URL, fragment included", async () => {
    await h.createLink(author.key, domain, {
      slug: "no-presets",
      destination: "https://example.com/path?x=1#frag",
    })
    const res = await get("/no-presets")
    expect(res.headers.get("location")).toBe("https://example.com/path?x=1#frag")
  })

  test("presets apply to a rule's destination, not just the default one", async () => {
    const link = await h.createLink(author.key, domain, {
      slug: "preset-rule",
      destination: "https://example.com/default",
      presetParams: { a: "preset" },
    })
    await h.request(`/api/v1/links/${link.id}/rules`, {
      key: author.key,
      method: "PUT",
      body: JSON.stringify([
        {
          destination: "https://example.com/android?a=dest",
          conditions: [{ type: "platform", value: "android" }],
        },
      ]),
    })

    const res = await get("/preset-rule", { headers: { "user-agent": ANDROID } })
    const location = new URL(res.headers.get("location") as string)
    expect(location.origin + location.pathname).toBe("https://example.com/android")
    expect(location.searchParams.get("a")).toBe("preset")
  })
})

describe("visitor detection", () => {
  test("records the platform, os and browser each user agent implies", async () => {
    await h.createLink(author.key, domain, { slug: "ua" })

    for (const [userAgent, platform, os, browser] of [
      [ANDROID, "android", "android", "mobile chrome"],
      [IPHONE, "ios", "ios", "mobile safari"],
      [DESKTOP, "desktop", "macos", "chrome"],
    ] as const) {
      await get("/ua", { headers: { "user-agent": userAgent } })
      expect(await lastVisit()).toMatchObject({ platform, os, browser, isBot: false })
    }
  })

  test("flags bots and a missing user agent", async () => {
    await h.createLink(author.key, domain, { slug: "crawled" })

    await get("/crawled", { headers: { "user-agent": BOT } })
    expect(await lastVisit()).toMatchObject({ isBot: true })

    await h.request("/crawled", { host: HOST })
    expect(await lastVisit()).toMatchObject({ isBot: true, userAgent: null })
  })

  test("records a recognisable bot label, human visits get none", async () => {
    await h.createLink(author.key, domain, { slug: "labelled" })

    await get("/labelled", { headers: { "user-agent": BOT } })
    expect(await lastVisit()).toMatchObject({ isBot: true, botLabel: "google" })

    await get("/labelled")
    expect(await lastVisit()).toMatchObject({ isBot: false, botLabel: null })
  })

  test("a link-preview crawler gets the short link's own title, not the destination's", async () => {
    const link = await h.createLink(author.key, domain, { slug: "shared", name: "Q3 report" })
    const res = await get(`/${link.slug}`, {
      headers: { "user-agent": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" },
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("Q3 report")
    expect(body).not.toContain("example.com")
  })
})

describe("link expiry", () => {
  test("a past expiresAt resolves like an unknown slug: fallback, orphan visit", async () => {
    await h.createLink(author.key, domain, {
      slug: "lapsed",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })

    const res = await get("/lapsed")
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://example.com/fallback")
    expect(await lastVisit()).toMatchObject({
      linkId: null,
      slugRequested: "lapsed",
      destination: "https://example.com/fallback",
    })
  })

  test("expired with no fallback still 404s and still records the orphan", async () => {
    const bare = await h.createDomain("expiry-bare.test")
    await h.createLink(author.key, bare, {
      slug: "lapsed",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })

    const res = await get("/lapsed", { host: "expiry-bare.test" })
    expect(res.status).toBe(404)
    await flushVisits()
    const [row] = await h.db
      .select()
      .from(visits)
      .where(eq(visits.domainId, bare))
      .orderBy(desc(visits.id))
      .limit(1)
    expect(row).toMatchObject({ linkId: null, slugRequested: "lapsed" })
  })

  test("a future expiresAt redirects normally with linkId set", async () => {
    const link = await h.createLink(author.key, domain, {
      slug: "not-yet",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const res = await get("/not-yet")
    expect(res.status).toBe(302)
    expect(await lastVisit()).toMatchObject({ linkId: link.id })
  })

  test("a preview crawler on an expired link gets the orphan title, the host", async () => {
    await h.createLink(author.key, domain, {
      slug: "expired-preview",
      name: "Should not appear",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    const res = await get("/expired-preview", {
      headers: { "user-agent": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" },
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain(HOST)
    expect(body).not.toContain("Should not appear")
  })
})

describe("HEAD", () => {
  test("is answered like GET but never tracked", async () => {
    const link = await h.createLink(author.key, domain, { slug: "head" })

    const before = await visitCount()
    const res = await get("/head", { method: "HEAD" })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(link.destination)
    expect(await visitCount()).toBe(before)

    // An orphan HEAD is not tracked either.
    await get("/head-missing", { method: "HEAD" })
    expect(await visitCount()).toBe(before)
  })
})
