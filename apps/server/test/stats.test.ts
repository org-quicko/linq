import { beforeAll, describe, expect, test } from "bun:test"
import type { StatsBucket } from "@linq/shared"
import { createHarness, type Harness } from "./helpers/app.ts"

let h: Harness
let author: { keyId: string; key: string }
let domain: string
let otherDomain: string
let linkId: string
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
  linkId = link.id
  quietLinkId = (await h.createLink(author.key, domain, { slug: "quiet" })).id

  // Two days of traffic on one link, with a deliberate spread of dimensions.
  await h.recordVisits(
    linkId,
    domain,
    { human: 2 },
    {
      occurredAt: at("2026-03-01T10:00:00Z"),
      platform: "android",
      referer: "https://news.test/",
      destination: "https://example.com/a",
    },
  )
  await h.recordVisits(
    linkId,
    domain,
    { bot: 1 },
    {
      occurredAt: at("2026-03-01T11:00:00Z"),
      platform: "android",
      destination: "https://example.com/a",
    },
  )
  await h.recordVisits(
    linkId,
    domain,
    { human: 1 },
    {
      occurredAt: at("2026-03-02T09:00:00Z"),
      platform: "ios",
      destination: "https://example.com/b",
    },
  )

  // An orphan visit on the same domain, and one visit on a different domain.
  await h.recordVisits(
    null,
    domain,
    { human: 1 },
    {
      occurredAt: at("2026-03-02T12:00:00Z"),
      slugRequested: "missing",
      platform: "desktop",
    },
  )
  await h.recordVisits(
    null,
    otherDomain,
    { human: 1 },
    {
      occurredAt: at("2026-03-02T12:00:00Z"),
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
    const buckets = await stats(`/api/v1/links/${linkId}/stats?groupBy=day`)
    expect(buckets).toEqual([
      { key: "2026-03-01", human: 2, bot: 1 },
      { key: "2026-03-02", human: 1, bot: 0 },
    ])
  })

  test("groups by every other dimension, busiest first", async () => {
    expect(byKey(await stats(`/api/v1/links/${linkId}/stats?groupBy=platform`))).toEqual({
      android: { human: 2, bot: 1 },
      ios: { human: 1, bot: 0 },
    })
    expect(byKey(await stats(`/api/v1/links/${linkId}/stats?groupBy=destination`))).toEqual({
      "https://example.com/a": { human: 2, bot: 1 },
      "https://example.com/b": { human: 1, bot: 0 },
    })

    // The busiest bucket leads for a non-day grouping.
    const platforms = await stats(`/api/v1/links/${linkId}/stats?groupBy=platform`)
    expect(platforms[0].key).toBe("android")
  })

  test("a dimension that was never recorded buckets under an empty key", async () => {
    const referers = byKey(await stats(`/api/v1/links/${linkId}/stats?groupBy=referer`))
    expect(referers["https://news.test/"]).toEqual({ human: 2, bot: 0 })
    expect(referers[""]).toEqual({ human: 1, bot: 1 })
  })

  test("defaults to grouping by day", async () => {
    const buckets = await stats(`/api/v1/links/${linkId}/stats`)
    expect(buckets[0].key).toBe("2026-03-01")
  })

  /** Whole UTC days, both ends inclusive: the rollup has no finer grain. */
  test("narrows to a time window", async () => {
    const buckets = await stats(`/api/v1/links/${linkId}/stats?from=2026-03-02&groupBy=day`)
    expect(buckets).toEqual([{ key: "2026-03-02", human: 1, bot: 0 }])

    const upTo = await stats(`/api/v1/links/${linkId}/stats?to=2026-03-01&groupBy=day`)
    expect(upTo).toEqual([{ key: "2026-03-01", human: 2, bot: 1 }])
  })

  test("a window given as a timestamp is rejected", async () => {
    const res = await h.request(`/api/v1/links/${linkId}/stats?from=2026-03-02T00:00:00Z`, {
      key: author.key,
    })
    expect(res.status).toBe(400)
  })

  test("a link with no visits reports nothing rather than failing", async () => {
    expect(await stats(`/api/v1/links/${quietLinkId}/stats`)).toEqual([])
  })

  test("an unknown link is a 404, and a bad groupBy a 400", async () => {
    const missing = await h.request("/api/v1/links/00000000-0000-7000-8000-000000000000/stats", {
      key: author.key,
    })
    expect(missing.status).toBe(404)

    const bad = await h.request(`/api/v1/links/${linkId}/stats?groupBy=browser`, {
      key: author.key,
    })
    expect(bad.status).toBe(400)
  })

  test("every role may read stats", async () => {
    const viewer = await h.actor("viewer")
    expect((await h.request(`/api/v1/links/${linkId}/stats`, { key: viewer.key })).status).toBe(200)
  })
})

describe("GET /api/v1/domains/:id/stats", () => {
  test("covers every visit on the domain, orphans included", async () => {
    const buckets = await stats(`/api/v1/domains/${domain}/stats?groupBy=day`)
    expect(buckets).toEqual([
      { key: "2026-03-01", human: 2, bot: 1 },
      { key: "2026-03-02", human: 2, bot: 0 },
    ])
  })

  test("does not leak visits from another domain", async () => {
    const buckets = await stats(`/api/v1/domains/${otherDomain}/stats?groupBy=day`)
    expect(buckets).toEqual([{ key: "2026-03-02", human: 1, bot: 0 }])
  })
})

describe("GET /api/v1/stats", () => {
  test("covers the whole instance by default", async () => {
    const buckets = await stats("/api/v1/stats?groupBy=day")
    expect(buckets).toEqual([
      { key: "2026-03-01", human: 2, bot: 1 },
      { key: "2026-03-02", human: 3, bot: 0 },
    ])
  })

  test("orphan=true is the slice that resolved to no link", async () => {
    const buckets = await stats("/api/v1/stats?orphan=true&groupBy=day")
    expect(buckets).toEqual([{ key: "2026-03-02", human: 2, bot: 0 }])
  })

  test("orphan and domainId narrow together", async () => {
    const buckets = await stats(`/api/v1/stats?orphan=true&domainId=${domain}&groupBy=day`)
    expect(buckets).toEqual([{ key: "2026-03-02", human: 1, bot: 0 }])
  })

  test("domainId alone matches the per-domain endpoint", async () => {
    const global = await stats(`/api/v1/stats?domainId=${domain}&groupBy=platform`)
    const scoped = await stats(`/api/v1/domains/${domain}/stats?groupBy=platform`)
    expect(global).toEqual(scoped)
  })

  test("rejects a domainId that is not a uuid", async () => {
    const res = await h.request("/api/v1/stats?domainId=nope", { key: author.key })
    expect(res.status).toBe(400)
  })
})

describe("GET /api/v1/visits", () => {
  test("returns the raw log newest first, paginated", async () => {
    const res = await h.request(`/api/v1/visits?linkId=${linkId}&limit=2`, { key: author.key })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toMatchObject({ total: 4, limit: 2, offset: 0 })
    expect(body.data).toHaveLength(2)
    expect(body.data[0].occurredAt).toBe("2026-03-02T09:00:00.000Z")
    expect(body.data[0]).toMatchObject({
      linkId,
      domainId: domain,
      platform: "ios",
      isBot: false,
    })
  })

  test("filters humans from bots", async () => {
    const humans = await (
      await h.request(`/api/v1/visits?linkId=${linkId}&bot=false`, { key: author.key })
    ).json()
    expect(humans.total).toBe(3)

    const bots = await (
      await h.request(`/api/v1/visits?linkId=${linkId}&bot=true`, { key: author.key })
    ).json()
    expect(bots.total).toBe(1)
    expect(bots.data[0].isBot).toBe(true)
  })

  /** The raw log keeps instant precision; only the reports are day-grained. */
  test("filters by time window", async () => {
    const res = await h.request(`/api/v1/visits?linkId=${linkId}&from=2026-03-02T00:00:00Z`, {
      key: author.key,
    })
    expect((await res.json()).total).toBe(1)
  })

  test("never returns another link's visits, or an orphan", async () => {
    const res = await h.request(`/api/v1/visits?linkId=${quietLinkId}`, { key: author.key })
    expect(await res.json()).toMatchObject({ data: [], total: 0 })
  })

  test("narrows to one domain, and to the orphan slice", async () => {
    const onDomain = await (
      await h.request(`/api/v1/visits?domainId=${domain}`, { key: author.key })
    ).json()
    expect(onDomain.total).toBe(5)

    const orphans = await (
      await h.request("/api/v1/visits?orphan=true", { key: author.key })
    ).json()
    expect(orphans.total).toBe(2)
    expect(orphans.data.every((v: { linkId: string | null }) => v.linkId === null)).toBe(true)
  })

  /**
   * An unknown link reports nothing rather than 404ing: unlike the link-scoped
   * report this route is not about one link, it is the log with a filter on it.
   */
  test("an unknown link reports nothing", async () => {
    const res = await h.request("/api/v1/visits?linkId=00000000-0000-7000-8000-000000000000", {
      key: author.key,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ data: [], total: 0 })
  })
})
