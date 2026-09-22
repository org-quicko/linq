import { beforeAll, describe, expect, test } from "bun:test"
import { ANALYTICS_FILTERS, type StatsBucket } from "@linq/shared"
import { createHarness, type Harness } from "./helpers/app.ts"

let h: Harness
let author: { keyId: string; key: string }
let domain: string
let linkOne: string
let linkTwo: string

const at = (iso: string) => new Date(iso)

beforeAll(async () => {
  h = await createHarness()
  author = await h.actor("author")
  domain = await h.createDomain("analytics.test", "https://example.com/fallback")

  const one = await h.createLink(author.key, domain, { slug: "one" })
  const two = await h.createLink(author.key, domain, { slug: "two" })
  linkOne = one.id
  linkTwo = two.id

  // Day 1: two humans + one bot on `one`, all android/chrome, one with a referer.
  await h.recordVisits(
    linkOne,
    domain,
    { human: 2 },
    {
      occurred_at: at("2026-03-01T10:00:00Z"),
      platform: "android",
      os: "android",
      browser: "chrome",
      referer: "https://news.test/path?q=1",
      destination: "https://example.com/a",
    },
  )
  await h.recordVisits(
    linkOne,
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
  // Day 2, late in the day: one human on `one`, ios/safari, a different referer host.
  await h.recordVisits(
    linkOne,
    domain,
    { human: 1 },
    {
      occurred_at: at("2026-03-02T23:30:00Z"),
      platform: "ios",
      os: "ios",
      browser: "safari",
      referer: "https://shop.test/",
      destination: "https://example.com/b",
    },
  )
  // Day 2: one human on `two`, windows/edge, no referer.
  await h.recordVisits(
    linkTwo,
    domain,
    { human: 1 },
    {
      occurred_at: at("2026-03-02T09:00:00Z"),
      platform: "desktop",
      os: "windows",
      browser: "edge",
      destination: "https://example.com/c",
    },
  )
  // Day 2: one orphan human, nothing recorded beyond platform.
  await h.recordVisits(
    null,
    domain,
    { human: 1 },
    { occurred_at: at("2026-03-02T12:00:00Z"), slug_requested: "missing", platform: "desktop" },
  )
})

const analytics = async (path: string, key = author.key) => {
  const res = await h.request(`/api/v1/analytics${path}`, { key })
  return res
}

const json = async (path: string, key = author.key) => {
  const res = await analytics(path, key)
  expect(res.status).toBe(200)
  return await res.json()
}

const byKey = (buckets: StatsBucket[]) =>
  Object.fromEntries(buckets.map((b) => [b.key, { human: b.human, bot: b.bot }]))

const WINDOW = "from=2026-02-01&to=2026-03-31"

describe("GET /api/v1/analytics/summary", () => {
  test("visits is human plus bot, orphans counted separately", async () => {
    const summary = await json("/summary")
    expect(summary).toEqual({ visits: 6, human: 5, bot: 1, orphans: 1 })
  })

  test("a link filter zeroes orphans without querying for them", async () => {
    const summary = await json(`/summary?link_id=${linkOne}`)
    expect(summary).toEqual({ visits: 4, human: 3, bot: 1, orphans: 0 })
  })

  test("a dimension filter forces the detail path and agrees with the rollup", async () => {
    const rollup = await json("/summary")
    const detail = await json(`/summary?${WINDOW}&os=android,ios,windows,(none)`)
    expect(detail).toEqual(rollup)
  })
})

describe("GET /api/v1/analytics/timeseries", () => {
  test("chronological, and the last day of the window is included", async () => {
    const buckets: StatsBucket[] = await json("/timeseries?to=2026-03-02")
    expect(buckets).toEqual([
      { key: "2026-03-01", human: 2, bot: 1 },
      { key: "2026-03-02", human: 3, bot: 0 },
    ])
  })

  test("the detail path includes the same last day, even late in it", async () => {
    // Forces the detail path; occurred_at up to 23:30 on the 2nd must still
    // land in the window, not be cut at midnight (plans/Plan_33.md §F).
    const buckets: StatsBucket[] = await json("/timeseries?from=2026-02-01&to=2026-03-02&os=ios")
    expect(buckets).toEqual([{ key: "2026-03-02", human: 1, bot: 0 }])
  })
})

describe("GET /api/v1/analytics/breakdown", () => {
  test("ranked by volume, busiest first", async () => {
    const buckets: StatsBucket[] = await json("/breakdown?dimension=platform")
    expect(buckets.map((b) => b.key)).toEqual(["android", "desktop", "ios"])
  })

  test("an unrecorded value buckets under '' and is reachable via (none)", async () => {
    const referers = byKey(await json("/breakdown?dimension=referer"))
    // '' covers the day-1 bot (no referer), link two's human and the orphan.
    expect(referers[""]).toEqual({ human: 2, bot: 1 })
    expect(referers["news.test"]).toEqual({ human: 2, bot: 0 })
    expect(referers["shop.test"]).toEqual({ human: 1, bot: 0 })

    const filtered = byKey(await json(`/breakdown?dimension=referer&${WINDOW}&referer=(none)`))
    expect(Object.keys(filtered)).toEqual([""])
    expect(filtered[""]).toEqual({ human: 2, bot: 1 })
  })

  test("OR within a dimension, AND across dimensions", async () => {
    // Two referer hosts: widens (OR) to both link-one visits that carry one.
    const or = await json(`/breakdown?dimension=os&${WINDOW}&referer=news.test,shop.test`)
    expect(byKey(or)).toEqual({ android: { human: 2, bot: 0 }, ios: { human: 1, bot: 0 } })

    // referer + os together: narrows (AND) to just the android/news.test visits.
    const and = await json(`/breakdown?dimension=platform&${WINDOW}&referer=news.test&os=android`)
    expect(byKey(and)).toEqual({ android: { human: 2, bot: 0 } })
  })

  test("path equivalence: an all-inclusive filter matches the unfiltered rollup", async () => {
    const values: Record<(typeof ANALYTICS_FILTERS)[number], string> = {
      referer: "news.test,shop.test,(none)",
      os: "android,ios,windows,(none)",
      browser: "chrome,safari,edge,(none)",
      platform: "android,ios,desktop",
    }
    for (const dimension of ANALYTICS_FILTERS) {
      const rollup = byKey(await json(`/breakdown?dimension=${dimension}`))
      const detail = byKey(
        await json(`/breakdown?dimension=${dimension}&${WINDOW}&${dimension}=${values[dimension]}`),
      )
      expect(detail).toEqual(rollup)
    }
  })

  test("rejects an unknown dimension", async () => {
    expect((await analytics("/breakdown?dimension=country")).status).toBe(400)
  })
})

describe("validation", () => {
  test("to before from is rejected", async () => {
    expect((await analytics("/summary?from=2026-03-02&to=2026-03-01")).status).toBe(400)
  })

  test("a dimension filter with no from is rejected", async () => {
    expect((await analytics("/summary?os=android")).status).toBe(400)
  })

  test("a dimension filter spanning more than a year is rejected", async () => {
    expect((await analytics("/summary?from=2025-01-01&to=2026-03-01&os=android")).status).toBe(400)
  })

  test("every role may read all three endpoints", async () => {
    const viewer = await h.actor("viewer")
    expect((await analytics("/summary", viewer.key)).status).toBe(200)
    expect((await analytics("/timeseries", viewer.key)).status).toBe(200)
    expect((await analytics("/breakdown?dimension=os", viewer.key)).status).toBe(200)
  })
})
