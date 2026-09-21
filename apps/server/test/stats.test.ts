import { beforeAll, describe, expect, test } from "bun:test"
import type { StatsBucket } from "@linq/shared"
import { createHarness, type Harness } from "./helpers/app.ts"

let h: Harness
let author: { keyId: string; key: string }
let domain: string
let otherDomain: string
let link_id: string
let quietLinkId: string

const at = (iso: string) => new Date(iso)

beforeAll(async () => {
  h = await createHarness()
  author = await h.actor("author")
  domain = await h.createDomain("stats.test", "https://example.com/fallback")
  otherDomain = await h.createDomain("elsewhere.test")

  const link = await h.createLink(author.key, domain, {
    slug: "tracked",
    destination: "https://example.com/a",
  })
  link_id = link.id
  quietLinkId = (await h.createLink(author.key, domain, { slug: "quiet" })).id

  // Two days of traffic on one link, with a deliberate spread of dimensions.
  await h.recordVisits(
    link_id,
    domain,
    { human: 2 },
    {
      occurred_at: at("2026-03-01T10:00:00Z"),
      platform: "android",
      os: "android",
      browser: "chrome",
      referer: "https://news.test/",
      destination: "https://example.com/a",
    },
  )
  await h.recordVisits(
    link_id,
    domain,
    { bot: 1 },
    {
      occurred_at: at("2026-03-01T11:00:00Z"),
      platform: "android",
      os: "android",
      browser: "chrome",
      destination: "https://example.com/a",
    },
  )
  await h.recordVisits(
    link_id,
    domain,
    { human: 1 },
    {
      occurred_at: at("2026-03-02T09:00:00Z"),
      platform: "ios",
      os: "ios",
      browser: "safari",
      destination: "https://example.com/b",
    },
  )

  // An orphan visit on the same domain, and one visit on a different domain.
  await h.recordVisits(
    null,
    domain,
    { human: 1 },
    {
      occurred_at: at("2026-03-02T12:00:00Z"),
      slug_requested: "missing",
      platform: "desktop",
    },
  )
  await h.recordVisits(
    null,
    otherDomain,
    { human: 1 },
    {
      occurred_at: at("2026-03-02T12:00:00Z"),
      platform: "desktop",
    },
  )
})

const stats = async (path: string, key = author.key): Promise<StatsBucket[]> => {
  const res = await h.request(path, { key })
  expect(res.status).toBe(200)
  return await res.json()
}

const byKey = (buckets: StatsBucket[]) =>
  Object.fromEntries(buckets.map((b) => [b.key, { human: b.human, bot: b.bot }]))

describe("GET /api/v1/links/:id/stats", () => {
  test("groups by UTC day, chronologically, splitting human from bot", async () => {
    const buckets = await stats(`/api/v1/links/${link_id}/stats?group_by=day`)
    expect(buckets).toEqual([
      { key: "2026-03-01", human: 2, bot: 1 },
      { key: "2026-03-02", human: 1, bot: 0 },
    ])
  })

  test("groups by every other dimension, busiest first", async () => {
    expect(byKey(await stats(`/api/v1/links/${link_id}/stats?group_by=platform`))).toEqual({
      android: { human: 2, bot: 1 },
      ios: { human: 1, bot: 0 },
    })
    expect(byKey(await stats(`/api/v1/links/${link_id}/stats?group_by=destination`))).toEqual({
      "https://example.com/a": { human: 2, bot: 1 },
      "https://example.com/b": { human: 1, bot: 0 },
    })

    // The busiest bucket leads for a non-day grouping.
    const platforms = await stats(`/api/v1/links/${link_id}/stats?group_by=platform`)
    expect(platforms[0].key).toBe("android")
  })

  test("groups by os and browser too", async () => {
    expect(byKey(await stats(`/api/v1/links/${link_id}/stats?group_by=os`))).toEqual({
      android: { human: 2, bot: 1 },
      ios: { human: 1, bot: 0 },
    })
    expect(byKey(await stats(`/api/v1/links/${link_id}/stats?group_by=browser`))).toEqual({
      chrome: { human: 2, bot: 1 },
      safari: { human: 1, bot: 0 },
    })
  })

  test("a dimension that was never recorded buckets under an empty key", async () => {
    const referers = byKey(await stats(`/api/v1/links/${link_id}/stats?group_by=referer`))
    expect(referers["https://news.test/"]).toEqual({ human: 2, bot: 0 })
    expect(referers[""]).toEqual({ human: 1, bot: 1 })
  })

  test("defaults to grouping by day", async () => {
    const buckets = await stats(`/api/v1/links/${link_id}/stats`)
    expect(buckets[0].key).toBe("2026-03-01")
  })

  /** Whole UTC days, both ends inclusive: the rollup has no finer grain. */
  test("narrows to a time window", async () => {
    const buckets = await stats(`/api/v1/links/${link_id}/stats?from=2026-03-02&group_by=day`)
    expect(buckets).toEqual([{ key: "2026-03-02", human: 1, bot: 0 }])

    const upTo = await stats(`/api/v1/links/${link_id}/stats?to=2026-03-01&group_by=day`)
    expect(upTo).toEqual([{ key: "2026-03-01", human: 2, bot: 1 }])
  })

  test("a window given as a timestamp is rejected", async () => {
    const res = await h.request(`/api/v1/links/${link_id}/stats?from=2026-03-02T00:00:00Z`, {
      key: author.key,
    })
    expect(res.status).toBe(400)
  })

  test("a link with no visits reports nothing rather than failing", async () => {
    expect(await stats(`/api/v1/links/${quietLinkId}/stats`)).toEqual([])
  })

  test("an unknown link is a 404, and a bad group_by a 400", async () => {
    const missing = await h.request("/api/v1/links/00000000-0000-7000-8000-000000000000/stats", {
      key: author.key,
    })
    expect(missing.status).toBe(404)

    const bad = await h.request(`/api/v1/links/${link_id}/stats?group_by=country`, {
      key: author.key,
    })
    expect(bad.status).toBe(400)
  })

  test("every role may read stats", async () => {
    const viewer = await h.actor("viewer")
    expect((await h.request(`/api/v1/links/${link_id}/stats`, { key: viewer.key })).status).toBe(200)
  })
})

describe("GET /api/v1/domains/:id/stats", () => {
  test("covers every visit on the domain, orphans included", async () => {
    const buckets = await stats(`/api/v1/domains/${domain}/stats?group_by=day`)
    expect(buckets).toEqual([
      { key: "2026-03-01", human: 2, bot: 1 },
      { key: "2026-03-02", human: 2, bot: 0 },
    ])
  })

  test("does not leak visits from another domain", async () => {
    const buckets = await stats(`/api/v1/domains/${otherDomain}/stats?group_by=day`)
    expect(buckets).toEqual([{ key: "2026-03-02", human: 1, bot: 0 }])
  })
})

describe("GET /api/v1/stats", () => {
  test("covers the whole instance by default", async () => {
    const buckets = await stats("/api/v1/stats?group_by=day")
    expect(buckets).toEqual([
      { key: "2026-03-01", human: 2, bot: 1 },
      { key: "2026-03-02", human: 3, bot: 0 },
    ])
  })

  test("orphan=true is the slice that resolved to no link", async () => {
    const buckets = await stats("/api/v1/stats?orphan=true&group_by=day")
    expect(buckets).toEqual([{ key: "2026-03-02", human: 2, bot: 0 }])
  })

  test("orphan and domain_id narrow together", async () => {
    const buckets = await stats(`/api/v1/stats?orphan=true&domain_id=${domain}&group_by=day`)
    expect(buckets).toEqual([{ key: "2026-03-02", human: 1, bot: 0 }])
  })

  test("domain_id alone matches the per-domain endpoint", async () => {
    const global = await stats(`/api/v1/stats?domain_id=${domain}&group_by=platform`)
    const scoped = await stats(`/api/v1/domains/${domain}/stats?group_by=platform`)
    expect(global).toEqual(scoped)
  })

  test("rejects a domain_id that is not a uuid", async () => {
    const res = await h.request("/api/v1/stats?domain_id=nope", { key: author.key })
    expect(res.status).toBe(400)
  })
})

describe("GET /api/v1/visits", () => {
  test("returns the raw log newest first, paginated", async () => {
    const res = await h.request(`/api/v1/visits?link_id=${link_id}&limit=2`, { key: author.key })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toMatchObject({ total: 4, limit: 2, offset: 0 })
    expect(body.data).toHaveLength(2)
    expect(body.data[0].occurred_at).toBe("2026-03-02T09:00:00.000Z")
    expect(body.data[0]).toMatchObject({
      link_id,
      domain_id: domain,
      platform: "ios",
      is_bot: false,
    })
  })

  test("filters humans from bots", async () => {
    const humans = await (
      await h.request(`/api/v1/visits?link_id=${link_id}&bot=false`, { key: author.key })
    ).json()
    expect(humans.total).toBe(3)

    const bots = await (
      await h.request(`/api/v1/visits?link_id=${link_id}&bot=true`, { key: author.key })
    ).json()
    expect(bots.total).toBe(1)
    expect(bots.data[0].is_bot).toBe(true)
  })

  test("filters by platform, os and browser", async () => {
    const android = await (
      await h.request(`/api/v1/visits?link_id=${link_id}&platform=android`, { key: author.key })
    ).json()
    expect(android.total).toBe(3)

    const ios = await (
      await h.request(`/api/v1/visits?link_id=${link_id}&os=ios`, { key: author.key })
    ).json()
    expect(ios.total).toBe(1)

    const safari = await (
      await h.request(`/api/v1/visits?link_id=${link_id}&browser=safari`, { key: author.key })
    ).json()
    expect(safari.total).toBe(1)
    expect(safari.data[0]).toMatchObject({ os: "ios", browser: "safari" })
  })

  /** The raw log keeps instant precision; only the reports are day-grained. */
  test("filters by time window", async () => {
    const res = await h.request(`/api/v1/visits?link_id=${link_id}&from=2026-03-02T00:00:00Z`, {
      key: author.key,
    })
    expect((await res.json()).total).toBe(1)
  })

  test("never returns another link's visits, or an orphan", async () => {
    const res = await h.request(`/api/v1/visits?link_id=${quietLinkId}`, { key: author.key })
    expect(await res.json()).toMatchObject({ data: [], total: 0 })
  })

  test("narrows to one domain, and to the orphan slice", async () => {
    const onDomain = await (
      await h.request(`/api/v1/visits?domain_id=${domain}`, { key: author.key })
    ).json()
    expect(onDomain.total).toBe(5)

    const orphans = await (
      await h.request("/api/v1/visits?orphan=true", { key: author.key })
    ).json()
    expect(orphans.total).toBe(2)
    expect(orphans.data.every((v: { link_id: string | null }) => v.link_id === null)).toBe(true)
  })

  /**
   * An unknown link reports nothing rather than 404ing: unlike the link-scoped
   * report this route is not about one link, it is the log with a filter on it.
   */
  test("an unknown link reports nothing", async () => {
    const res = await h.request("/api/v1/visits?link_id=00000000-0000-7000-8000-000000000000", {
      key: author.key,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ data: [], total: 0 })
  })
})
