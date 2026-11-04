import { describe, expect, test } from "bun:test"
import { flushVisits, recordVisit, type VisitInput } from "../src/visits/record.ts"
import { createHarness } from "./helpers/app.ts"
import { testConfig } from "./helpers/db.ts"

const settings = testConfig

const visit = (domain_id: string, link_id: string | null = null): VisitInput => ({
  domain_id,
  link_id,
  slug_requested: "test",
  is_bot: false,
  platform: "desktop",
})

describe("recordVisit batching", () => {
  test("writes visits without waiting for a batch to fill", async () => {
    const h = await createHarness()
    const domain = await h.createDomain("batch.test")

    for (let i = 0; i < 3; i++) recordVisit(h.db, visit(domain), settings)
    // Not flushVisits: three visits are far short of a full batch, and they must
    // land anyway, as soon as the database is free.
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      if ((await h.db.selectFrom("visits").selectAll().execute()).length === 3) break
      await Bun.sleep(10)
    }

    const rows = await h.db.selectFrom("visits").select("occurred_at").execute()
    expect(rows).toHaveLength(3)
    // Stamped at emit time, not by the column default at insert.
    for (const r of rows) expect(r.occurred_at).toBeInstanceOf(Date)
  })

  test("one bad row costs that row, not its batch", async () => {
    const h = await createHarness()
    const domain = await h.createDomain("bad-row.test")

    recordVisit(h.db, visit(domain), settings)
    // No such link: the foreign key rejects this row, and with it the batch INSERT.
    recordVisit(h.db, visit(domain, Bun.randomUUIDv7()), settings)
    recordVisit(h.db, visit(domain), settings)
    await flushVisits()

    expect(await h.db.selectFrom("visits").selectAll().execute()).toHaveLength(2)
  })

  test("drops visits beyond LINQ_VISIT_MAX_PENDING", async () => {
    const h = await createHarness()
    const domain = await h.createDomain("full.test")
    const capped = { ...settings, LINQ_VISIT_MAX_PENDING: 2, LINQ_VISIT_BATCH_SIZE: 2 }

    for (let i = 0; i < 5; i++) recordVisit(h.db, visit(domain), capped)
    await flushVisits()

    expect(await h.db.selectFrom("visits").selectAll().execute()).toHaveLength(2)
  })
})
