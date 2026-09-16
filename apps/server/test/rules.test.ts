import { beforeAll, describe, expect, test } from "bun:test"
import type { Condition } from "@linq/shared"
import { desc, eq } from "drizzle-orm"
import { flushClicks } from "../src/clicks/record.ts"
import { clicks } from "../src/db/schema.ts"
import { matchRules, ruleMatches } from "../src/rules/match.ts"
import { createHarness, type Harness } from "./helpers/app.ts"

const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile"
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120"

const ctx = (over: { platform?: string; query?: string; country?: string | null } = {}) => ({
  platform: (over.platform ?? "desktop") as "android" | "ios" | "desktop",
  query: new URLSearchParams(over.query ?? ""),
  country: over.country === undefined ? null : over.country,
})

const rule = (destination: string, conditions: Condition[]) => ({ destination, conditions })

describe("ruleMatches", () => {
  test("every condition must hold", () => {
    const both: Condition[] = [
      { type: "platform", value: "android" },
      { type: "query_param", key: "utm_source", value: "ads" },
    ]
    expect(
      ruleMatches({ conditions: both }, ctx({ platform: "android", query: "utm_source=ads" })),
    ).toBe(true)
    expect(
      ruleMatches({ conditions: both }, ctx({ platform: "android", query: "utm_source=x" })),
    ).toBe(false)
    expect(
      ruleMatches({ conditions: both }, ctx({ platform: "ios", query: "utm_source=ads" })),
    ).toBe(false)
  })

  test("a rule with no conditions never matches", () => {
    expect(ruleMatches({ conditions: [] }, ctx())).toBe(false)
    expect(ruleMatches({ conditions: [] }, ctx({ platform: "android", country: "IN" }))).toBe(false)
  })

  describe("query_param", () => {
    test("without a value it only needs the key present", () => {
      const c: Condition[] = [{ type: "query_param", key: "beta" }]
      expect(ruleMatches({ conditions: c }, ctx({ query: "beta=1" }))).toBe(true)
      expect(ruleMatches({ conditions: c }, ctx({ query: "beta=" }))).toBe(true)
      expect(ruleMatches({ conditions: c }, ctx({ query: "beta" }))).toBe(true)
      expect(ruleMatches({ conditions: c }, ctx({ query: "other=1" }))).toBe(false)
      expect(ruleMatches({ conditions: c }, ctx())).toBe(false)
    })

    test("with a value it must match exactly", () => {
      const c: Condition[] = [{ type: "query_param", key: "v", value: "2" }]
      expect(ruleMatches({ conditions: c }, ctx({ query: "v=2" }))).toBe(true)
      expect(ruleMatches({ conditions: c }, ctx({ query: "v=20" }))).toBe(false)
      expect(ruleMatches({ conditions: c }, ctx({ query: "v=" }))).toBe(false)
      expect(ruleMatches({ conditions: c }, ctx({ query: "v" }))).toBe(false)
    })

    test("a repeated key matches when any copy matches", () => {
      const c: Condition[] = [{ type: "query_param", key: "t", value: "b" }]
      expect(ruleMatches({ conditions: c }, ctx({ query: "t=a&t=b" }))).toBe(true)
      expect(ruleMatches({ conditions: c }, ctx({ query: "t=a&t=c" }))).toBe(false)
    })
  })

  describe("country", () => {
    test("matches the geo result, case-insensitively", () => {
      const c: Condition[] = [{ type: "country", value: "IN" }]
      expect(ruleMatches({ conditions: c }, ctx({ country: "IN" }))).toBe(true)
      expect(ruleMatches({ conditions: c }, ctx({ country: "in" }))).toBe(true)
      expect(ruleMatches({ conditions: c }, ctx({ country: "US" }))).toBe(false)
    })

    test("fails when geo is unavailable rather than matching everything", () => {
      const c: Condition[] = [{ type: "country", value: "IN" }]
      expect(ruleMatches({ conditions: c }, ctx({ country: null }))).toBe(false)
    })
  })
})

describe("matchRules", () => {
  const rules = [
    rule("https://example.com/android", [{ type: "platform", value: "android" }]),
    rule("https://example.com/promo", [{ type: "query_param", key: "promo" }]),
    rule("https://example.com/india", [{ type: "country", value: "IN" }]),
  ]

  test("the first rule in order wins, even when a later one also matches", () => {
    const both = ctx({ platform: "android", query: "promo=1" })
    expect(matchRules(rules, both)).toBe("https://example.com/android")

    // Reversing the order reverses the winner: position is the only tiebreak.
    expect(matchRules([...rules].reverse(), both)).toBe("https://example.com/promo")
  })

  test("returns null when nothing matches, so the default destination is used", () => {
    expect(matchRules(rules, ctx({ platform: "desktop" }))).toBeNull()
    expect(matchRules([], ctx({ platform: "android" }))).toBeNull()
  })

  test("skips a non-matching rule to reach a later match", () => {
    expect(matchRules(rules, ctx({ platform: "ios", country: "IN" }))).toBe(
      "https://example.com/india",
    )
  })
})

describe("the rules API", () => {
  let h: Harness
  let author: { userId: string; key: string }
  let domain: string

  beforeAll(async () => {
    h = await createHarness()
    author = await h.actor("author")
    domain = await h.createDomain("rules.test")
  })

  const put = (linkId: string, key: string, body: unknown) =>
    h.request(`/api/v1/links/${linkId}/rules`, { key, method: "PUT", body: JSON.stringify(body) })

  const androidRule = {
    destination: "https://example.com/app",
    conditions: [{ type: "platform", value: "android" }],
  }

  test("a link starts with no rules", async () => {
    const link = await h.createLink(author.key, domain)
    const res = await h.request(`/api/v1/links/${link.id}/rules`, { key: author.key })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  test("PUT assigns positions in body order and replaces the whole set", async () => {
    const link = await h.createLink(author.key, domain)
    const first = await put(link.id, author.key, [
      androidRule,
      { destination: "https://example.com/ios", conditions: [{ type: "platform", value: "ios" }] },
    ])
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject([
      { position: 0, destination: "https://example.com/app" },
      { position: 1, destination: "https://example.com/ios" },
    ])

    // A second PUT is a full replacement, not a merge.
    const second = await put(link.id, author.key, [
      { destination: "https://example.com/only", conditions: [{ type: "country", value: "in" }] },
    ])
    const body = await second.json()
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({ position: 0, destination: "https://example.com/only" })
    // The country code is normalised to upper case on the way in.
    expect(body[0].conditions).toEqual([{ type: "country", value: "IN" }])
  })

  test("an empty array clears every rule", async () => {
    const link = await h.createLink(author.key, domain)
    await put(link.id, author.key, [androidRule])
    expect(await (await put(link.id, author.key, [])).json()).toEqual([])
  })

  test("rejects a rule with no conditions", async () => {
    const link = await h.createLink(author.key, domain)
    const res = await put(link.id, author.key, [
      { destination: "https://example.com/x", conditions: [] },
    ])
    expect(res.status).toBe(400)
  })

  test("rejects a bad destination, country code and condition type", async () => {
    const link = await h.createLink(author.key, domain)
    const cases = [
      [{ destination: "/relative", conditions: [{ type: "platform", value: "android" }] }],
      [{ destination: "https://e.test/", conditions: [{ type: "country", value: "IND" }] }],
      [{ destination: "https://e.test/", conditions: [{ type: "weather", value: "rain" }] }],
      [{ destination: "https://e.test/", conditions: [{ type: "platform", value: "windows" }] }],
    ]
    for (const body of cases) {
      expect((await put(link.id, author.key, body)).status).toBe(400)
    }
  })

  test("permissions follow the link, not the rules", async () => {
    const link = await h.createLink(author.key, domain)
    const viewer = await h.actor("viewer")
    const stranger = await h.actor("author")
    const editor = await h.actor("editor")

    // Everyone may read.
    expect((await h.request(`/api/v1/links/${link.id}/rules`, { key: viewer.key })).status).toBe(
      200,
    )

    expect((await put(link.id, viewer.key, [androidRule])).status).toBe(403)
    expect((await put(link.id, stranger.key, [androidRule])).status).toBe(403)
    expect((await put(link.id, author.key, [androidRule])).status).toBe(200)
    expect((await put(link.id, editor.key, [androidRule])).status).toBe(200)
  })

  test("an unknown link is a 404 on both verbs", async () => {
    const missing = "00000000-0000-7000-8000-000000000000"
    expect((await h.request(`/api/v1/links/${missing}/rules`, { key: author.key })).status).toBe(
      404,
    )
    expect((await put(missing, author.key, [])).status).toBe(404)
  })

  test("archiving a link leaves its rules alone", async () => {
    const link = await h.createLink(author.key, domain)
    await put(link.id, author.key, [androidRule])
    await h.request(`/api/v1/links/${link.id}`, { key: author.key, method: "DELETE" })

    const res = await h.request(`/api/v1/links/${link.id}/rules`, { key: author.key })
    expect(await res.json()).toHaveLength(1)
  })
})

describe("rules in the redirect", () => {
  let h: Harness
  let author: { userId: string; key: string }
  let domain: string
  const HOST = "ruled.test"

  beforeAll(async () => {
    h = await createHarness()
    author = await h.actor("author")
    domain = await h.createDomain(HOST)
  })

  const get = (path: string, userAgent = DESKTOP) =>
    h.request(path, { host: HOST, headers: { "user-agent": userAgent } })

  const location = async (path: string, userAgent = DESKTOP) =>
    (await get(path, userAgent)).headers.get("location")

  test("a platform rule wins over the default destination", async () => {
    const link = await h.createLink(author.key, domain, {
      slug: "app",
      destination: "https://example.com/web",
    })
    await h.request(`/api/v1/links/${link.id}/rules`, {
      key: author.key,
      method: "PUT",
      body: JSON.stringify([
        {
          destination: "https://play.google.com/store",
          conditions: [{ type: "platform", value: "android" }],
        },
        {
          destination: "https://apps.apple.com/app",
          conditions: [{ type: "platform", value: "ios" }],
        },
      ]),
    })

    expect(await location("/app", ANDROID)).toBe("https://play.google.com/store")
    expect(await location("/app", IPHONE)).toBe("https://apps.apple.com/app")
    expect(await location("/app", DESKTOP)).toBe("https://example.com/web")
  })

  test("the click records the destination the rule chose, not the default", async () => {
    const link = await h.createLink(author.key, domain, {
      slug: "tracked",
      destination: "https://example.com/web",
    })
    await h.request(`/api/v1/links/${link.id}/rules`, {
      key: author.key,
      method: "PUT",
      body: JSON.stringify([
        {
          destination: "https://example.com/android",
          conditions: [{ type: "platform", value: "android" }],
        },
      ]),
    })

    await get("/tracked", ANDROID)
    await flushClicks()
    const [row] = await h.db
      .select()
      .from(clicks)
      .where(eq(clicks.linkId, link.id))
      .orderBy(desc(clicks.id))
      .limit(1)
    expect(row).toMatchObject({
      destination: "https://example.com/android",
      platform: "android",
    })
  })

  test("the first matching rule wins when several could", async () => {
    const link = await h.createLink(author.key, domain, {
      slug: "ordered",
      destination: "https://example.com/default",
    })
    const body = [
      { destination: "https://example.com/first", conditions: [{ type: "query_param", key: "a" }] },
      {
        destination: "https://example.com/second",
        conditions: [{ type: "query_param", key: "b" }],
      },
    ]
    await h.request(`/api/v1/links/${link.id}/rules`, {
      key: author.key,
      method: "PUT",
      body: JSON.stringify(body),
    })

    const url = new URL((await location("/ordered?a=1&b=1")) as string)
    expect(url.origin + url.pathname).toBe("https://example.com/first")
  })

  test("a matched destination still gets the incoming query merged into it", async () => {
    const link = await h.createLink(author.key, domain, {
      slug: "merged",
      destination: "https://example.com/web",
    })
    await h.request(`/api/v1/links/${link.id}/rules`, {
      key: author.key,
      method: "PUT",
      body: JSON.stringify([
        {
          destination: "https://example.com/app?ref=rule",
          conditions: [{ type: "platform", value: "android" }],
        },
      ]),
    })

    const url = new URL((await location("/merged?utm=x", ANDROID)) as string)
    expect(url.pathname).toBe("/app")
    expect(url.searchParams.get("ref")).toBe("rule")
    expect(url.searchParams.get("utm")).toBe("x")
  })

  test("a country rule needs geo, and is skipped without it", async () => {
    const located = await createHarness({
      geo: { lookup: () => ({ country: "IN", region: "Gujarat" }), stop: () => {} },
    })
    const owner = await located.actor("author")
    const scoped = await located.createDomain("geo-rules.test")
    const link = await located.createLink(owner.key, scoped, {
      slug: "here",
      destination: "https://example.com/global",
    })
    const rulesBody = JSON.stringify([
      { destination: "https://example.com/in", conditions: [{ type: "country", value: "IN" }] },
    ])
    await located.request(`/api/v1/links/${link.id}/rules`, {
      key: owner.key,
      method: "PUT",
      body: rulesBody,
    })

    const withGeo = await located.request("/here", {
      host: "geo-rules.test",
      headers: { "user-agent": DESKTOP },
    })
    expect(withGeo.headers.get("location")).toBe("https://example.com/in")

    // Same rule, same request, but no geo database configured.
    const blind = await createHarness()
    const blindOwner = await blind.actor("author")
    const blindDomain = await blind.createDomain("geo-rules.test")
    const blindLink = await blind.createLink(blindOwner.key, blindDomain, {
      slug: "here",
      destination: "https://example.com/global",
    })
    await blind.request(`/api/v1/links/${blindLink.id}/rules`, {
      key: blindOwner.key,
      method: "PUT",
      body: rulesBody,
    })
    const without = await blind.request("/here", {
      host: "geo-rules.test",
      headers: { "user-agent": DESKTOP },
    })
    expect(without.headers.get("location")).toBe("https://example.com/global")
  })

  test("an orphan click never consults rules", async () => {
    const res = await get("/no-such-slug")
    expect(res.status).toBe(404)
  })
})
