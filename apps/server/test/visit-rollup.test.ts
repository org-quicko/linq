import { beforeEach, describe, expect, test } from "bun:test"
import { sql } from "kysely"
import type { Db } from "../src/db/client.ts"
import { flushVisits } from "../src/visits/record.ts"
import { createHarness, type Harness } from "./helpers/app.ts"

const HOST = "rollup.test"
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120"
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile"
const BOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"

const DIMENSIONS = {
  total: sql<string>`''`,
  platform: sql<string>`platform::text`,
  referer: sql<string>`coalesce(referer_host, '')`,
  destination: sql<string>`coalesce(destination, '')`,
  slug: sql<string>`slug_requested`,
} as const

async function liveDays(db: Db, dimension: keyof typeof DIMENSIONS) {
  const rows = await db
    .selectFrom("visits")
    .select([
      sql<string>`to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD')`.as("day"),
      "domain_id",
      "link_id",
      DIMENSIONS[dimension].as("value"),
      "is_bot",
      sql<number>`count(*)`.as("count"),
    ])
    .groupBy(sql`1, 2, 3, 4, 5`)
    .execute()
  return rows
    .map(
      (row) =>
        `${row.day}|${row.domain_id}|${row.link_id ?? "-"}|${row.value}|${row.is_bot}|${row.count}`,
    )
    .sort()
}

async function rolledDays(db: Db, dimension: keyof typeof DIMENSIONS) {
  const rows = await db
    .selectFrom("visit_days")
    .selectAll()
    .where("dimension", "=", dimension)
    .execute()
  return rows
    .map(
      (row) =>
        `${row.day.toISOString().slice(0, 10)}|${row.domain_id}|${row.link_id ?? "-"}|${row.value}|${row.is_bot}|${row.count}`,
    )
    .sort()
}

async function liveCounts(db: Db) {
  const rows = await db
    .selectFrom("visits")
    .select([
      "domain_id",
      "link_id",
      sql<number>`count(*) filter (where not is_bot)`.as("human"),
      sql<number>`count(*) filter (where is_bot)`.as("bot"),
    ])
    .groupBy(["domain_id", "link_id"])
    .execute()
  return rows.map((row) => `${row.domain_id}|${row.link_id ?? "-"}|${row.human}|${row.bot}`).sort()
}

async function rolledCounts(db: Db) {
  const rows = await db.selectFrom("visit_counts").selectAll().execute()
  return rows.map((row) => `${row.domain_id}|${row.link_id ?? "-"}|${row.human}|${row.bot}`).sort()
}

let h: Harness
let editor: { keyId: string; key: string }
let admin: { keyId: string; key: string }
let domain: string

beforeEach(async () => {
  h = await createHarness()
  editor = await h.actor("editor")
  admin = await h.actor("admin")
  domain = await h.createDomain(HOST, "https://example.com/fallback")
})

async function traffic() {
  const one = await h.createLink(editor.key, domain, { slug: "one" })
  const two = await h.createLink(editor.key, domain, { slug: "two" })
  for (const [slug, agent, referer] of [
    ["one", DESKTOP, "https://news.test/"],
    ["one", DESKTOP, "https://news.test/"],
    ["one", ANDROID, null],
    ["one", BOT, null],
    ["two", DESKTOP, null],
    ["two", BOT, "https://crawler.test/"],
    ["ghost", DESKTOP, null],
    ["", DESKTOP, null],
  ] as const) {
    const headers: Record<string, string> = { "user-agent": agent }
    if (referer) headers.referer = referer
    await h.request(`/${slug}`, { host: HOST, headers })
  }
  await flushVisits()
  return { one, two }
}

describe("the day-wise rollup", () => {
  test("agrees with a live aggregate on every dimension", async () => {
    await traffic()
    for (const dimension of Object.keys(DIMENSIONS) as (keyof typeof DIMENSIONS)[])
      expect(await rolledDays(h.db, dimension)).toEqual(await liveDays(h.db, dimension))
  })

  test("counts the day's whole traffic under `total`", async () => {
    await traffic()
    const rolled = await h.db
      .selectFrom("visit_days")
      .select(sql<number>`coalesce(sum(count), 0)`.as("rolled"))
      .where("dimension", "=", "total")
      .executeTakeFirstOrThrow()
    expect(Number(rolled.rolled)).toBe((await h.db.selectFrom("visits").selectAll().execute()).length)
  })

  test("a second visit increments the row rather than adding one", async () => {
    await h.createLink(editor.key, domain, { slug: "again" })
    const hit = () => h.request("/again", { host: HOST, headers: { "user-agent": DESKTOP } })
    await hit()
    await flushVisits()
    const after1 = await h.db.selectFrom("visit_days").selectAll().where("dimension", "=", "total").execute()
    await hit()
    await flushVisits()
    const after2 = await h.db.selectFrom("visit_days").selectAll().where("dimension", "=", "total").execute()
    expect(after1).toHaveLength(1)
    expect(after2).toHaveLength(1)
    expect(after2[0]?.count).toBe(2)
  })

  test("an unrecorded dimension is stored as an empty value, not a word", async () => {
    await h.createLink(editor.key, domain, { slug: "bare" })
    await h.request("/bare", { host: HOST, headers: { "user-agent": DESKTOP } })
    await flushVisits()
    const row = await h.db
      .selectFrom("visit_days")
      .selectAll()
      .where("dimension", "=", "referer")
      .executeTakeFirstOrThrow()
    expect(row.value).toBe("")
  })
})

describe("the summary counts", () => {
  test("agree with a live aggregate", async () => {
    await traffic()
    expect(await rolledCounts(h.db)).toEqual(await liveCounts(h.db))
  })

  test("split human and bot, and remember the last visit", async () => {
    const link = await h.createLink(editor.key, domain, { slug: "split" })
    for (const agent of [DESKTOP, DESKTOP, BOT])
      await h.request("/split", { host: HOST, headers: { "user-agent": agent } })
    await flushVisits()
    const row = await h.db
      .selectFrom("visit_counts")
      .selectAll()
      .where("link_id", "=", link.id)
      .executeTakeFirstOrThrow()
    expect({ human: row.human, bot: row.bot }).toEqual({ human: 2, bot: 1 })
    expect(row.last_visit_at).not.toBeNull()
  })

  test("orphans get one row per domain, not one per slug", async () => {
    await h.request("/nowhere", { host: HOST, headers: { "user-agent": DESKTOP } })
    await h.request("/elsewhere", { host: HOST, headers: { "user-agent": DESKTOP } })
    await flushVisits()
    const rows = await h.db.selectFrom("visit_counts").selectAll().where("link_id", "is", null).execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.human).toBe(2)
  })
})

describe("purge", () => {
  test("a purged link's rollups are destroyed, not orphaned", async () => {
    const { one } = await traffic()
    const before = { days: await liveDays(h.db, "total"), counts: await liveCounts(h.db) }
    expect(before.days.length).toBeGreaterThan(1)
    const orphanBefore = await h.db
      .selectFrom("visit_counts")
      .selectAll()
      .where("domain_id", "=", domain)
      .where("link_id", "is", null)
      .execute()
    await h.request(`/api/v1/links/${one.id}`, { key: admin.key, method: "DELETE" })
    await h.request(`/api/v1/links/${one.id}/purge`, { key: admin.key, method: "DELETE" })
    for (const dimension of Object.keys(DIMENSIONS) as (keyof typeof DIMENSIONS)[])
      expect(await rolledDays(h.db, dimension)).toEqual(await liveDays(h.db, dimension))
    expect(await rolledCounts(h.db)).toEqual(await liveCounts(h.db))
    expect(await h.db.selectFrom("visit_days").selectAll().where("link_id", "=", one.id).execute()).toHaveLength(0)
    const orphanAfter = await h.db
      .selectFrom("visit_counts")
      .selectAll()
      .where("domain_id", "=", domain)
      .where("link_id", "is", null)
      .execute()
    expect(orphanAfter).toEqual(orphanBefore)
  })

  test("a purged domain takes its rollups with it", async () => {
    const spare = await h.createDomain("spare.test")
    const link = await h.createLink(editor.key, spare, { slug: "doomed" })
    await h.request("/doomed", { host: "spare.test", headers: { "user-agent": DESKTOP } })
    await h.recordVisits(null, spare, { human: 1 })
    await flushVisits()
    expect(await h.db.selectFrom("visit_days").selectAll().where("domain_id", "=", spare).execute()).not.toHaveLength(0)
    await h.request(`/api/v1/links/${link.id}`, { key: admin.key, method: "DELETE" })
    await h.request(`/api/v1/links/${link.id}/purge`, { key: admin.key, method: "DELETE" })
    const orphanAfterLinkPurge = await h.db
      .selectFrom("visit_counts")
      .selectAll()
      .where("domain_id", "=", spare)
      .where("link_id", "is", null)
      .execute()
    expect(orphanAfterLinkPurge).not.toHaveLength(0)
    await h.request(`/api/v1/domains/${spare}`, { key: admin.key, method: "DELETE" })
    await h.request(`/api/v1/domains/${spare}/purge`, { key: admin.key, method: "DELETE" })
    expect(await h.db.selectFrom("visit_days").selectAll().where("domain_id", "=", spare).execute()).toHaveLength(0)
    expect(
      await h.db
        .selectFrom("visit_counts")
        .selectAll()
        .where("domain_id", "=", spare)
        .where("link_id", "is", null)
        .execute(),
    ).toHaveLength(0)
  })
})
