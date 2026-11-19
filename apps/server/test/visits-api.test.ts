import { beforeAll, describe, expect, test } from "bun:test"
import { createHarness, type Harness } from "./helpers/app.ts"

let h: Harness
let viewer: { key: string }
let domain: string

beforeAll(async () => {
  h = await createHarness()
  viewer = await h.actor("viewer")
  domain = await h.createDomain("visits-api.test")

  // A nullable classification preserves rows written before the feature.
  await h.recordVisits(null, domain, { human: 1 }, { bot_classification_reason: null })
  await h.recordVisits(null, domain, { bot: 1 }, { bot_classification_reason: "isbot_match" })
})

describe("GET /api/v1/visits", () => {
  test("pages tied timestamps in stable id order while preserving filters and totals", async () => {
    const scopedDomain = await h.createDomain("visit-pages.test")
    const ids = [Bun.randomUUIDv7(), Bun.randomUUIDv7(), Bun.randomUUIDv7()].sort().reverse()
    await h.db
      .insertInto("visits")
      .values(
        ids.map((id) => ({
          id,
          domain_id: scopedDomain,
          slug_requested: "page",
          is_bot: false,
          platform: "desktop" as const,
          visited_at: new Date("2026-01-01T00:00:00Z"),
        })),
      )
      .execute()
    for (let offset = 0; offset < ids.length + 1; offset++) {
      const res = await h.request(
        `/api/v1/visits?domain_id=${scopedDomain}&limit=1&offset=${offset}`,
        { key: viewer.key },
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.total).toBe(3)
      expect(body.data.map((visit: { id: string }) => visit.id)).toEqual(
        ids.slice(offset, offset + 1),
      )
    }
  })
  test("returns classifications while preserving unclassified historical visits", async () => {
    const res = await h.request(`/api/v1/visits?domain_id=${domain}`, { key: viewer.key })
    expect(res.status).toBe(200)

    const body = await res.json()
    const classifications = body.data.map(
      (visit: { bot_classification_reason: string | null }) => visit.bot_classification_reason,
    )
    expect(classifications).toContain("isbot_match")
    expect(classifications).toContain(null)
  })
})
