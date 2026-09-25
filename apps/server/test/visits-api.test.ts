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
  await h.recordVisits(null, domain, { human: 1 }, { bot_classification: null })
  await h.recordVisits(null, domain, { bot: 1 }, { bot_classification: "isbot_match" })
})

describe("GET /api/v1/visits", () => {
  test("returns classifications while preserving unclassified historical visits", async () => {
    const res = await h.request(`/api/v1/visits?domain_id=${domain}`, { key: viewer.key })
    expect(res.status).toBe(200)

    const body = await res.json()
    const classifications = body.data.map(
      (visit: { bot_classification: string | null }) => visit.bot_classification,
    )
    expect(classifications).toContain("isbot_match")
    expect(classifications).toContain(null)
  })
})
