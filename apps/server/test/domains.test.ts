import { beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import type { Caddy } from "../src/caddy.ts"
import { domains } from "../src/db/schema.ts"
import { createHarness, type Harness } from "./helpers/app.ts"

let h: Harness
let admin: { keyId: string; key: string }

beforeAll(async () => {
  h = await createHarness()
  admin = await h.actor("admin")
})

describe("POST /api/v1/domains", () => {
  test("only an admin creates domains", async () => {
    const manager = await h.actor("manager")
    const res = await h.post("/api/v1/domains", manager.key, { host: "nope.test" })
    expect(res.status).toBe(403)
  })

  test("creates a domain and lowercases the host", async () => {
    const res = await h.post("/api/v1/domains", admin.key, {
      host: "Links.Example.COM",
      fallbackUrl: "https://example.com/home",
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({
      host: "links.example.com",
      fallbackUrl: "https://example.com/home",
      status: "active",
      linkCount: 0,
    })
  })

  test("refuses a duplicate host with 409", async () => {
    const res = await h.post("/api/v1/domains", admin.key, { host: "links.example.com" })
    expect(res.status).toBe(409)
  })

  test("rejects a host that is not a hostname", async () => {
    const res = await h.post("/api/v1/domains", admin.key, { host: "https://links.example.com/x" })
    expect(res.status).toBe(400)
  })

  test("rejects a fallback that is not an absolute http(s) URL", async () => {
    const res = await h.post("/api/v1/domains", admin.key, {
      host: "other.test",
      fallbackUrl: "/relative",
    })
    expect(res.status).toBe(400)
  })
})

describe("GET /api/v1/domains", () => {
  test("every role may read the list", async () => {
    const viewer = await h.actor("viewer")
    const res = await h.request("/api/v1/domains", { key: viewer.key })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.total).toBeGreaterThan(0)
    expect(body.data[0]).toHaveProperty("linkCount")
  })

  test("counts every link, archived included", async () => {
    const domain = await h.createDomain("counted.test")
    const author = await h.actor("author")
    const kept = await h.createLink(author.key, domain, { slug: "kept" })
    await h.createLink(author.key, domain, { slug: "dropped" })

    const before = await (await h.request(`/api/v1/domains/${domain}`, { key: admin.key })).json()
    expect(before.linkCount).toBe(2)

    // The count is now "what must reach zero to archive or purge the
    // domain", so archiving a link no longer drops it out.
    await h.request(`/api/v1/links/${kept.id}`, { key: author.key, method: "DELETE" })
    const after = await (await h.request(`/api/v1/domains/${domain}`, { key: admin.key })).json()
    expect(after.linkCount).toBe(2)
  })
})

describe("archiving a domain", () => {
  test("is refused with 409 while an active link exists", async () => {
    const domain = await h.createDomain("busy.test")
    const author = await h.actor("author")
    await h.createLink(author.key, domain, { slug: "busy" })

    const viaDelete = await h.request(`/api/v1/domains/${domain}`, {
      key: admin.key,
      method: "DELETE",
    })
    expect(viaDelete.status).toBe(409)

    const viaPatch = await h.patch(`/api/v1/domains/${domain}`, admin.key, { status: "archived" })
    expect(viaPatch.status).toBe(409)
  })

  test("is refused with 409 while only an archived link exists", async () => {
    const domain = await h.createDomain("archived-link.test")
    const author = await h.actor("author")
    const link = await h.createLink(author.key, domain, { slug: "stale" })
    // Archiving the link does not clear the way any more: the archive bar
    // now matches the purge bar.
    await h.request(`/api/v1/links/${link.id}`, { key: author.key, method: "DELETE" })

    const res = await h.request(`/api/v1/domains/${domain}`, { key: admin.key, method: "DELETE" })
    expect(res.status).toBe(409)
    expect((await res.json()).error.message).toContain("1 link")
  })

  test("archives cleanly once its only link is purged", async () => {
    const domain = await h.createDomain("purge-first.test")
    const author = await h.actor("author")
    const link = await h.createLink(author.key, domain, { slug: "gone" })
    await h.request(`/api/v1/links/${link.id}`, { key: author.key, method: "DELETE" })

    const stillBlocked = await h.request(`/api/v1/domains/${domain}`, {
      key: admin.key,
      method: "DELETE",
    })
    expect(stillBlocked.status).toBe(409)

    await h.request(`/api/v1/links/${link.id}/purge`, { key: admin.key, method: "DELETE" })
    const retry = await h.request(`/api/v1/domains/${domain}`, { key: admin.key, method: "DELETE" })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ status: "archived" })
  })

  test("an empty domain archives straight away and can be reactivated", async () => {
    const domain = await h.createDomain("empty.test")
    const archived = await h.request(`/api/v1/domains/${domain}`, {
      key: admin.key,
      method: "DELETE",
    })
    expect(await archived.json()).toMatchObject({ status: "archived" })

    const back = await h.patch(`/api/v1/domains/${domain}`, admin.key, { status: "active" })
    expect(await back.json()).toMatchObject({ status: "active" })
  })

  test("a link cannot be created on an archived domain", async () => {
    const domain = await h.createDomain("closed.test")
    await h.request(`/api/v1/domains/${domain}`, { key: admin.key, method: "DELETE" })

    const author = await h.actor("author")
    const res = await h.post("/api/v1/links", author.key, {
      domainId: domain,
      destination: "https://example.com",
    })
    expect(res.status).toBe(409)
  })
})

describe("purging a domain", () => {
  test("is refused with 409, not 500, while an archived link exists", async () => {
    const domain = await h.createDomain("purge-archived-link.test")
    const author = await h.actor("author")
    const link = await h.createLink(author.key, domain, { slug: "leftover" })
    await h.request(`/api/v1/links/${link.id}`, { key: author.key, method: "DELETE" })

    // The API can no longer put a domain in this state — A1 raised the
    // archive bar to match the purge bar, so archiving is itself refused
    // while this link exists. Written directly to reproduce exactly what
    // A2's race would otherwise leave behind, and to prove the purge
    // handler's own guard (A3) holds regardless of how the domain got here.
    await h.db.update(domains).set({ status: "archived" }).where(eq(domains.id, domain))

    const res = await h.request(`/api/v1/domains/${domain}/purge`, {
      key: admin.key,
      method: "DELETE",
    })
    expect(res.status).toBe(409)
  })
})

describe("PATCH /api/v1/domains/:id", () => {
  test("only an admin may change a fallback", async () => {
    const domain = await h.createDomain("fallback.test")
    const manager = await h.actor("manager")
    expect(
      (await h.patch(`/api/v1/domains/${domain}`, manager.key, { fallbackUrl: null })).status,
    ).toBe(403)

    const ok = await h.patch(`/api/v1/domains/${domain}`, admin.key, {
      fallbackUrl: "https://example.com/oops",
    })
    expect(await ok.json()).toMatchObject({ fallbackUrl: "https://example.com/oops" })

    const cleared = await h.patch(`/api/v1/domains/${domain}`, admin.key, { fallbackUrl: null })
    expect(await cleared.json()).toMatchObject({ fallbackUrl: null })
  })

  test("an unknown domain is a 404", async () => {
    const res = await h.request("/api/v1/domains/00000000-0000-7000-8000-000000000000", {
      key: admin.key,
    })
    expect(res.status).toBe(404)
  })
})

describe("caddy sync", () => {
  /** Records every call instead of talking to a real Caddy. */
  function spyCaddy(): Caddy & { upserts: string[]; removes: string[] } {
    const upserts: string[] = []
    const removes: string[] = []
    return {
      upserts,
      removes,
      upsert: async (domainId) => void upserts.push(domainId),
      remove: async (domainId) => void removes.push(domainId),
    }
  }

  test("create upserts the new domain", async () => {
    const caddy = spyCaddy()
    const own = await createHarness({ caddy })
    const owner = await own.actor("admin")

    const res = await own.post("/api/v1/domains", owner.key, { host: "synced.test" })
    const body = await res.json()
    expect(caddy.upserts).toEqual([body.id])
    expect(caddy.removes).toEqual([])
  })

  test("archiving removes the route, reactivating upserts it again", async () => {
    const caddy = spyCaddy()
    const own = await createHarness({ caddy })
    const owner = await own.actor("admin")
    const domain = await own.createDomain("archive-sync.test")

    await own.request(`/api/v1/domains/${domain}`, { key: owner.key, method: "DELETE" })
    expect(caddy.removes).toEqual([domain])

    await own.patch(`/api/v1/domains/${domain}`, owner.key, { status: "active" })
    expect(caddy.upserts).toEqual([domain])
  })

  test("a fallback-only patch touches neither", async () => {
    const caddy = spyCaddy()
    const own = await createHarness({ caddy })
    const owner = await own.actor("admin")
    const domain = await own.createDomain("fallback-sync.test")

    await own.patch(`/api/v1/domains/${domain}`, owner.key, {
      fallbackUrl: "https://example.com/x",
    })
    expect(caddy.upserts).toEqual([])
    expect(caddy.removes).toEqual([])
  })

  test("purging an archived, empty domain removes its route", async () => {
    const caddy = spyCaddy()
    const own = await createHarness({ caddy })
    const owner = await own.actor("admin")
    const domain = await own.createDomain("purge-sync.test")

    await own.request(`/api/v1/domains/${domain}`, { key: owner.key, method: "DELETE" })
    await own.request(`/api/v1/domains/${domain}/purge`, { key: owner.key, method: "DELETE" })
    expect(caddy.removes).toEqual([domain, domain])
  })
})
