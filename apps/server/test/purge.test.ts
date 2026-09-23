import { beforeAll, describe, expect, test } from "bun:test"
import { createHarness, type Harness } from "./helpers/app.ts"

/**
 * Purge is the one operation that destroys data, so every test here has a
 * counterpart elsewhere pinning what archiving does instead. See docs/adr/0002.
 */

let h: Harness
let admin: { keyId: string; key: string }
let author: { keyId: string; key: string }
let domain: string

const purge = (h: Harness, path: string, key: string) =>
  h.request(`/api/v1/${path}/purge`, { key, method: "DELETE" })

const archive = (h: Harness, path: string, key: string) =>
  h.request(`/api/v1/${path}`, { key, method: "DELETE" })

/** Reads the analytics summary for the selected scope. */
async function totalVisits(h: Harness, query: string, key: string): Promise<number> {
  const summary = await (await h.request(`/api/v1/analytics/summary?${query}`, { key })).json()
  return summary.visits
}

beforeAll(async () => {
  h = await createHarness()
  admin = await h.actor("admin")
  author = await h.actor("author")
  domain = await h.createDomain("purge.test")
})

describe("DELETE /api/v1/links/:id/purge", () => {
  test("refuses a link that is still active", async () => {
    const link = await h.createLink(author.key, domain, { slug: "live" })
    const res = await purge(h, `links/${link.id}`, admin.key)

    expect(res.status).toBe(409)
    // Still there, still redirecting.
    expect((await h.request(`/api/v1/links/${link.id}`, { key: admin.key })).status).toBe(200)
  })

  test("an unknown id is 404", async () => {
    const missing = "01998e0e-0000-7000-8000-000000000000"
    expect((await purge(h, `links/${missing}`, admin.key)).status).toBe(404)
  })

  test("only an admin may purge, even the owner may not", async () => {
    const link = await h.createLink(author.key, domain, { slug: "mine" })
    await archive(h, `links/${link.id}`, author.key)

    expect((await purge(h, `links/${link.id}`, author.key)).status).toBe(403)
    const manager = await h.actor("manager")
    expect((await purge(h, `links/${link.id}`, manager.key)).status).toBe(403)
    // …and the row survived both refusals.
    expect((await h.request(`/api/v1/links/${link.id}`, { key: admin.key })).status).toBe(200)
  })

  test("purging releases the slug, which archiving never does", async () => {
    // The deliberate inverse of links.test.ts, "refuses a slug already taken on
    // the domain, archived ones included".
    const link = await h.createLink(author.key, domain, { slug: "reusable" })
    await archive(h, `links/${link.id}`, author.key)

    const taken = await h.post("/api/v1/links", author.key, {
      domain_id: domain,
      destination: "https://example.com/",
      slug: "reusable",
    })
    expect(taken.status).toBe(409)

    expect((await purge(h, `links/${link.id}`, admin.key)).status).toBe(204)
    expect((await h.request(`/api/v1/links/${link.id}`, { key: admin.key })).status).toBe(404)

    const reborn = await h.createLink(author.key, domain, { slug: "reusable" })
    expect(reborn.slug).toBe("reusable")
    expect(reborn.id).not.toBe(link.id)
  })

  test("its visits are destroyed with it", async () => {
    const fresh = await createHarness()
    const boss = await fresh.actor("admin")
    const host = await fresh.createDomain("orphans.test")
    const link = await fresh.createLink(boss.key, host, { slug: "counted" })

    await fresh.recordVisits(link.id, host, { human: 3, bot: 1 })
    expect(await totalVisits(fresh, "orphan=true", boss.key)).toBe(0)

    await archive(fresh, `links/${link.id}`, boss.key)
    expect((await purge(fresh, `links/${link.id}`, boss.key)).status).toBe(204)

    // Gone, not detached: `visits.link_id` is ON DELETE cascade.
    expect(await totalVisits(fresh, "", boss.key)).toBe(0)
    expect(await totalVisits(fresh, "orphan=true", boss.key)).toBe(0)
  })

  test("its rules go with it", async () => {
    // The inverse of rules.test.ts, "archiving a link leaves its rules alone".
    const link = await h.createLink(author.key, domain, { slug: "ruled" })
    await h.request(`/api/v1/links/${link.id}/rules`, {
      key: author.key,
      method: "PUT",
      body: JSON.stringify([
        { destination: "https://example.com/a", conditions: [{ type: "platform", value: "ios" }] },
      ]),
    })
    expect(
      await (await h.request(`/api/v1/links/${link.id}/rules`, { key: author.key })).json(),
    ).toHaveLength(1)

    await archive(h, `links/${link.id}`, author.key)
    expect((await purge(h, `links/${link.id}`, admin.key)).status).toBe(204)

    expect((await h.request(`/api/v1/links/${link.id}/rules`, { key: admin.key })).status).toBe(404)
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

  test("refuses while any link remains, archived ones included", async () => {
    const host = await h.createDomain("occupied.test")
    const link = await h.createLink(author.key, host, { slug: "squatter" })

    await archive(h, `links/${link.id}`, author.key)

    // The domain itself cannot even be archived while the link — archived or
    // not — still points at it: the archive bar now matches the purge bar.
    expect((await archive(h, `domains/${host}`, admin.key)).status).toBe(409)

    expect((await purge(h, `links/${link.id}`, admin.key)).status).toBe(204)

    expect((await archive(h, `domains/${host}`, admin.key)).status).toBe(200)
    expect((await purge(h, `domains/${host}`, admin.key)).status).toBe(204)
    expect((await h.request(`/api/v1/domains/${host}`, { key: admin.key })).status).toBe(404)
  })

  test("takes its visits with it, and the global total shrinks", async () => {
    const fresh = await createHarness()
    const boss = await fresh.actor("admin")
    const kept = await fresh.createDomain("kept.test")
    const doomed = await fresh.createDomain("doomed.test")

    await fresh.recordVisits(null, kept, { human: 2 })
    await fresh.recordVisits(null, doomed, { human: 5, bot: 2 })
    expect(await totalVisits(fresh, "", boss.key)).toBe(9)

    await archive(fresh, `domains/${doomed}`, boss.key)
    expect((await purge(fresh, `domains/${doomed}`, boss.key)).status).toBe(204)

    // Unlike a link purge, these visits are gone: `visits.domain_id` is NOT NULL.
    expect(await totalVisits(fresh, "", boss.key)).toBe(2)
  })
})
