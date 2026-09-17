import { beforeEach, describe, expect, test } from "bun:test"
import { and, eq, isNull, sql } from "drizzle-orm"
import type { Db } from "../src/db/client.ts"
import { visitCounts, visitDays, visits } from "../src/db/schema.ts"
import { flushVisits } from "../src/visits/record.ts"
import { createHarness, type Harness } from "./helpers/app.ts"

const HOST = "rollup.test"
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120"
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile"
const BOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"

/** The seven dimensions the trigger writes, and the visit column each one reads. */
const DIMENSIONS = {
  total: sql`''`,
  country: sql`coalesce(${visits.country}, '')`,
  region: sql`coalesce(${visits.region}, '')`,
  platform: sql`${visits.platform}::text`,
  referer: sql`coalesce(${visits.referer}, '')`,
  destination: sql`coalesce(${visits.destination}, '')`,
  slug: sql`${visits.slugRequested}`,
} as const

/**
 * The same numbers computed the old way: a live aggregate over `visits`. Every
 * assertion below compares the rollup against this rather than against a
 * hand-counted literal, so a drifting increment cannot pass by agreeing with a
 * stale expectation.
 */
async function liveDays(db: Db, dimension: keyof typeof DIMENSIONS) {
  const rows = await db
    .select({
      day: sql<string>`to_char(${visits.occurredAt} at time zone 'UTC', 'YYYY-MM-DD')`.as("day"),
      domainId: visits.domainId,
      linkId: visits.linkId,
      value: sql<string>`${DIMENSIONS[dimension]}`.as("value"),
      isBot: visits.isBot,
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(visits)
    .groupBy(sql`1, 2, 3, 4, 5`)
  return rows
    .map((r) => `${r.day}|${r.domainId}|${r.linkId ?? "-"}|${r.value}|${r.isBot}|${r.count}`)
    .sort()
}

async function rolledDays(db: Db, dimension: keyof typeof DIMENSIONS) {
  const rows = await db.select().from(visitDays).where(eq(visitDays.dimension, dimension))
  return rows
    .map((r) => `${r.day}|${r.domainId}|${r.linkId ?? "-"}|${r.value}|${r.isBot}|${r.count}`)
    .sort()
}

async function liveCounts(db: Db) {
  const rows = await db
    .select({
      domainId: visits.domainId,
      linkId: visits.linkId,
      human: sql<number>`count(*) filter (where not ${visits.isBot})`.mapWith(Number),
      bot: sql<number>`count(*) filter (where ${visits.isBot})`.mapWith(Number),
    })
    .from(visits)
    .groupBy(visits.domainId, visits.linkId)
  return rows.map((r) => `${r.domainId}|${r.linkId ?? "-"}|${r.human}|${r.bot}`).sort()
}

async function rolledCounts(db: Db) {
  const rows = await db.select().from(visitCounts)
  return rows.map((r) => `${r.domainId}|${r.linkId ?? "-"}|${r.human}|${r.bot}`).sort()
}

let h: Harness
let author: { userId: string; key: string }
let admin: { userId: string; key: string }
let domain: string

beforeEach(async () => {
  h = await createHarness()
  author = await h.actor("author")
  admin = await h.actor("admin")
  domain = await h.createDomain(HOST, "https://example.com/fallback")
})

/** Drives real traffic through the redirect, so the triggers see real rows. */
async function traffic() {
  const one = await h.createLink(author.key, domain, { slug: "one" })
  const two = await h.createLink(author.key, domain, { slug: "two" })

  for (const [slug, agent, referer] of [
    ["one", DESKTOP, "https://news.test/"],
    ["one", DESKTOP, "https://news.test/"],
    ["one", ANDROID, null],
    ["one", BOT, null],
    ["two", DESKTOP, null],
    ["two", BOT, "https://crawler.test/"],
    // Two orphans: an unknown slug and the root path.
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
    for (const dimension of Object.keys(DIMENSIONS) as (keyof typeof DIMENSIONS)[]) {
      expect(await rolledDays(h.db, dimension)).toEqual(await liveDays(h.db, dimension))
    }
  })

  test("counts the day's whole traffic under `total`", async () => {
    await traffic()
    const [{ rolled }] = await h.db
      .select({ rolled: sql<number>`coalesce(sum(${visitDays.count}), 0)`.mapWith(Number) })
      .from(visitDays)
      .where(eq(visitDays.dimension, "total"))
    expect(rolled).toBe((await h.db.select().from(visits)).length)
  })

  test("a second visit increments the row rather than adding one", async () => {
    await h.createLink(author.key, domain, { slug: "again" })
    const hit = () => h.request("/again", { host: HOST, headers: { "user-agent": DESKTOP } })

    await hit()
    await flushVisits()
    const after1 = await h.db.select().from(visitDays).where(eq(visitDays.dimension, "total"))
    await hit()
    await flushVisits()
    const after2 = await h.db.select().from(visitDays).where(eq(visitDays.dimension, "total"))

    expect(after1).toHaveLength(1)
    expect(after2).toHaveLength(1)
    expect(after2[0].count).toBe(2)
  })

  test("an unrecorded dimension is stored as an empty value, not a word", async () => {
    await h.createLink(author.key, domain, { slug: "bare" })
    await h.request("/bare", { host: HOST, headers: { "user-agent": DESKTOP } })
    await flushVisits()

    const [row] = await h.db.select().from(visitDays).where(eq(visitDays.dimension, "referer"))
    expect(row.value).toBe("")
  })
})

describe("the summary counts", () => {
  test("agree with a live aggregate", async () => {
    await traffic()
    expect(await rolledCounts(h.db)).toEqual(await liveCounts(h.db))
  })

  test("split human and bot, and remember the last visit", async () => {
    const link = await h.createLink(author.key, domain, { slug: "split" })
    for (const agent of [DESKTOP, DESKTOP, BOT]) {
      await h.request("/split", { host: HOST, headers: { "user-agent": agent } })
    }
    await flushVisits()

    const [row] = await h.db.select().from(visitCounts).where(eq(visitCounts.linkId, link.id))
    expect({ human: row.human, bot: row.bot }).toEqual({ human: 2, bot: 1 })
    expect(row.lastVisitAt).not.toBeNull()
  })

  test("orphans get one row per domain, not one per slug", async () => {
    await h.request("/nowhere", { host: HOST, headers: { "user-agent": DESKTOP } })
    await h.request("/elsewhere", { host: HOST, headers: { "user-agent": DESKTOP } })
    await flushVisits()

    const rows = await h.db.select().from(visitCounts).where(isNull(visitCounts.linkId))
    expect(rows).toHaveLength(1)
    expect(rows[0].human).toBe(2)
  })
})

describe("purge", () => {
  /** Purging a link detaches its visits; the rollups must detach with them. */
  test("a purged link's rollups become orphan rollups", async () => {
    const { one } = await traffic()
    const before = { days: await liveDays(h.db, "total"), counts: await liveCounts(h.db) }
    expect(before.days.length).toBeGreaterThan(1)

    await h.request(`/api/v1/links/${one.id}`, { key: author.key, method: "DELETE" })
    await h.request(`/api/v1/links/${one.id}/purge`, { key: admin.key, method: "DELETE" })

    // `visits.link_id` is now null for those rows, so the live aggregate has
    // moved too — and the rollup must have moved with it, merged into the
    // orphan rows that were already there.
    for (const dimension of Object.keys(DIMENSIONS) as (keyof typeof DIMENSIONS)[]) {
      expect(await rolledDays(h.db, dimension)).toEqual(await liveDays(h.db, dimension))
    }
    expect(await rolledCounts(h.db)).toEqual(await liveCounts(h.db))

    const leftBehind = await h.db.select().from(visitDays).where(eq(visitDays.linkId, one.id))
    expect(leftBehind).toHaveLength(0)
  })

  test("a purged domain takes its rollups with it", async () => {
    const spare = await h.createDomain("spare.test")
    const link = await h.createLink(author.key, spare, { slug: "doomed" })
    await h.request("/doomed", { host: "spare.test", headers: { "user-agent": DESKTOP } })
    await flushVisits()
    expect(
      await h.db.select().from(visitDays).where(eq(visitDays.domainId, spare)),
    ).not.toHaveLength(0)

    await h.request(`/api/v1/links/${link.id}`, { key: author.key, method: "DELETE" })
    await h.request(`/api/v1/links/${link.id}/purge`, { key: admin.key, method: "DELETE" })
    await h.request(`/api/v1/domains/${spare}`, { key: admin.key, method: "DELETE" })
    await h.request(`/api/v1/domains/${spare}/purge`, { key: admin.key, method: "DELETE" })

    expect(await h.db.select().from(visitDays).where(eq(visitDays.domainId, spare))).toHaveLength(0)
    expect(
      await h.db
        .select()
        .from(visitCounts)
        .where(and(eq(visitCounts.domainId, spare), isNull(visitCounts.linkId))),
    ).toHaveLength(0)
  })
})
