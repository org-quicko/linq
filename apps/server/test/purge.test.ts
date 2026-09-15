import { beforeAll, describe, expect, test } from "bun:test"
import { createHarness, type Harness } from "./helpers/app.ts"

/**
 * Purge is the one operation that destroys data, so every test here has a
 * counterpart elsewhere pinning what archiving does instead. See docs/adr/0002.
 */

let h: Harness
let admin: { userId: string; key: string }
let author: { userId: string; key: string }
let domain: string

const purge = (h: Harness, path: string, key: string) =>
  h.request(`/api/v1/${path}/purge`, { key, method: "DELETE" })

const archive = (h: Harness, path: string, key: string) =>
  h.request(`/api/v1/${path}`, { key, method: "DELETE" })

/** Sums the human and bot counts of a stats response. */
async function totalClicks(h: Harness, query: string, key: string): Promise<number> {
  const buckets = await (await h.request(`/api/v1/stats?${query}`, { key })).json()
  return buckets.reduce((n: number, b: { human: number; bot: number }) => n + b.human + b.bot, 0)
}

beforeAll(async () => {
  h = await createHarness()
  admin = await h.actor("admin")
  author = await h.actor("author")
  domain = await h.createDomain("purge.test")
})

describe("DELETE /api/v1/linqs/:id/purge", () => {
  test("refuses a linq that is still active", async () => {
    const linq = await h.createLinq(author.key, domain, { slug: "live" })
    const res = await purge(h, `linqs/${linq.id}`, admin.key)

    expect(res.status).toBe(409)
    // Still there, still redirecting.
    expect((await h.request(`/api/v1/linqs/${linq.id}`, { key: admin.key })).status).toBe(200)
  })

  test("an unknown id is 404", async () => {
    const missing = "01998e0e-0000-7000-8000-000000000000"
    expect((await purge(h, `linqs/${missing}`, admin.key)).status).toBe(404)
  })

  test("only an admin may purge, even the owner may not", async () => {
    const linq = await h.createLinq(author.key, domain, { slug: "mine" })
    await archive(h, `linqs/${linq.id}`, author.key)

    expect((await purge(h, `linqs/${linq.id}`, author.key)).status).toBe(403)
    const editor = await h.actor("editor")
    expect((await purge(h, `linqs/${linq.id}`, editor.key)).status).toBe(403)
    // …and the row survived both refusals.
    expect((await h.request(`/api/v1/linqs/${linq.id}`, { key: admin.key })).status).toBe(200)
  })

  test("purging releases the slug, which archiving never does", async () => {
    // The deliberate inverse of linqs.test.ts, "refuses a slug already taken on
    // the domain, archived ones included".
    const linq = await h.createLinq(author.key, domain, { slug: "reusable" })
    await archive(h, `linqs/${linq.id}`, author.key)

    const taken = await h.post("/api/v1/linqs", author.key, {
      domainId: domain,
      destination: "https://example.com/",
      slug: "reusable",
    })
    expect(taken.status).toBe(409)

    expect((await purge(h, `linqs/${linq.id}`, admin.key)).status).toBe(204)
    expect((await h.request(`/api/v1/linqs/${linq.id}`, { key: admin.key })).status).toBe(404)

    const reborn = await h.createLinq(author.key, domain, { slug: "reusable" })
    expect(reborn.slug).toBe("reusable")
    expect(reborn.id).not.toBe(linq.id)
  })

  test("its clicks survive as orphans", async () => {
    const fresh = await createHarness()
    const boss = await fresh.actor("admin")
    const host = await fresh.createDomain("orphans.test")
    const linq = await fresh.createLinq(boss.key, host, { slug: "counted" })

    await fresh.recordClicks(linq.id, host, { human: 3, bot: 1 })
    expect(await totalClicks(fresh, "orphan=true", boss.key)).toBe(0)

    await archive(fresh, `linqs/${linq.id}`, boss.key)
    expect((await purge(fresh, `linqs/${linq.id}`, boss.key)).status).toBe(204)

    // Nothing lost, only detached: `clicks.linq_id` is ON DELETE set null.
    expect(await totalClicks(fresh, "", boss.key)).toBe(4)
    expect(await totalClicks(fresh, "orphan=true", boss.key)).toBe(4)
  })

  test("its rules go with it", async () => {
    // The inverse of rules.test.ts, "archiving a linq leaves its rules alone".
    const linq = await h.createLinq(author.key, domain, { slug: "ruled" })
    await h.request(`/api/v1/linqs/${linq.id}/rules`, {
      key: author.key,
      method: "PUT",
      body: JSON.stringify([
        { destination: "https://example.com/a", conditions: [{ type: "platform", value: "ios" }] },
      ]),
    })
    expect(
      await (await h.request(`/api/v1/linqs/${linq.id}/rules`, { key: author.key })).json(),
    ).toHaveLength(1)

    await archive(h, `linqs/${linq.id}`, author.key)
    expect((await purge(h, `linqs/${linq.id}`, admin.key)).status).toBe(204)

    expect((await h.request(`/api/v1/linqs/${linq.id}/rules`, { key: admin.key })).status).toBe(404)
  })
})

describe("DELETE /api/v1/domains/:id/purge", () => {
  test("refuses a domain that is still active", async () => {
    const host = await h.createDomain("active.test")
    expect((await purge(h, `domains/${host}`, admin.key)).status).toBe(409)
  })

  test("only an admin may purge", async () => {
    const host = await h.createDomain("noadmin.test")
    await archive(h, `domains/${host}`, admin.key)
    expect((await purge(h, `domains/${host}`, author.key)).status).toBe(403)
  })

  test("refuses while any linq remains, archived ones included", async () => {
    const host = await h.createDomain("occupied.test")
    const linq = await h.createLinq(author.key, host, { slug: "squatter" })

    await archive(h, `linqs/${linq.id}`, author.key)
    await archive(h, `domains/${host}`, admin.key)

    // Archiving the domain was allowed — it only needs no *active* linqs — but
    // purging it is not, because the linq row still points at it.
    const res = await purge(h, `domains/${host}`, admin.key)
    expect(res.status).toBe(409)

    expect((await purge(h, `linqs/${linq.id}`, admin.key)).status).toBe(204)
    expect((await purge(h, `domains/${host}`, admin.key)).status).toBe(204)
    expect((await h.request(`/api/v1/domains/${host}`, { key: admin.key })).status).toBe(404)
  })

  test("takes its clicks with it, and the global total shrinks", async () => {
    const fresh = await createHarness()
    const boss = await fresh.actor("admin")
    const kept = await fresh.createDomain("kept.test")
    const doomed = await fresh.createDomain("doomed.test")

    await fresh.recordClicks(null, kept, { human: 2 })
    await fresh.recordClicks(null, doomed, { human: 5, bot: 2 })
    expect(await totalClicks(fresh, "", boss.key)).toBe(9)

    await archive(fresh, `domains/${doomed}`, boss.key)
    expect((await purge(fresh, `domains/${doomed}`, boss.key)).status).toBe(204)

    // Unlike a linq purge, these clicks are gone: `clicks.domain_id` is NOT NULL.
    expect(await totalClicks(fresh, "", boss.key)).toBe(2)
  })
})
