import { beforeAll, describe, expect, test } from "bun:test"
import { flushVisits, recordVisit } from "../src/services/VisitService.ts"
import { createHarness, type Harness } from "./helpers/app.ts"

let h: Harness
let domainId: string

beforeAll(async () => {
  h = await createHarness()
  domainId = await h.createDomain("pipeline.test")
})

const visit = (slug: string) => ({
  domain_id: domainId,
  link_id: null,
  slug_requested: slug,
  is_bot: false,
  platform: "desktop" as const,
  query_params: {},
})

const count = async (slug: string) =>
  Number(
    (
      await h.db
        .selectFrom("visits")
        .select((eb) => eb.fn.countAll().as("n"))
        .where("slug_requested", "=", slug)
        .executeTakeFirstOrThrow()
    ).n,
  )

describe("the OpenTelemetry visit pipeline", () => {
  test("a recorded visit reaches the visits table, stamped with its click time", async () => {
    const before = Date.now()
    recordVisit(h.db, visit("written"), 1_000)
    await flushVisits()
    const row = await h.db
      .selectFrom("visits")
      .select(["visited_at"])
      .where("slug_requested", "=", "written")
      .executeTakeFirstOrThrow()
    expect(row.visited_at.getTime()).toBeGreaterThanOrEqual(before - 1)
    expect(row.visited_at.getTime()).toBeLessThanOrEqual(Date.now())
  })

  // The insert must be in flight the moment `emit` returns: that is what the
  // cap counts and what `flushVisits` waits on. If the export ever became
  // asynchronous, the second call here would slip past the cap.
  test("the cap counts an emitted visit immediately, and drops past it", async () => {
    recordVisit(h.db, visit("capped"), 1)
    recordVisit(h.db, visit("capped"), 1)
    await flushVisits()
    expect(await count("capped")).toBe(1)
  })

  test("recording resumes once the backlog drains", async () => {
    recordVisit(h.db, visit("resumed"), 1)
    await flushVisits()
    recordVisit(h.db, visit("resumed"), 1)
    await flushVisits()
    expect(await count("resumed")).toBe(2)
  })

  test("a visit lands in the daily rollup like any other insert", async () => {
    recordVisit(h.db, visit("rolled"), 1_000)
    await flushVisits()
    const rolled = await h.db
      .selectFrom("visit_days")
      .select(["count"])
      .where("dimension", "=", "slug")
      .where("value", "=", "rolled")
      .executeTakeFirstOrThrow()
    expect(Number(rolled.count)).toBe(1)
  })
})
