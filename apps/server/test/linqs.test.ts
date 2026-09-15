import { beforeAll, describe, expect, test } from "bun:test"
import { createHarness, type Harness } from "./helpers/app.ts"

let h: Harness
let admin: { userId: string; key: string }
let author: { userId: string; key: string }
let domain: string

beforeAll(async () => {
  h = await createHarness()
  admin = await h.actor("admin")
  author = await h.actor("author")
  domain = await h.createDomain("links.test")
})

describe("POST /api/v1/linqs", () => {
  test("a viewer may not create one", async () => {
    const viewer = await h.actor("viewer")
    const res = await h.post("/api/v1/linqs", viewer.key, {
      domainId: domain,
      destination: "https://example.com/",
    })
    expect(res.status).toBe(403)
  })

  test("generates a slug of the configured length and owns it to the caller", async () => {
    const linq = await h.createLinq(author.key, domain, { destination: "https://example.com/a" })
    expect(linq.slug).toHaveLength(6)
    expect(linq.slug).toMatch(/^[A-Za-z0-9]{6}$/)
    expect(linq.ownerId).toBe(author.userId)
    expect(linq.shortUrl).toBe(`https://links.test/${linq.slug}`)
    expect(linq).toMatchObject({
      status: "active",
      forwardQuery: true,
      humanClicks: 0,
      botClicks: 0,
    })
  })

  test("accepts a custom slug", async () => {
    const linq = await h.createLinq(author.key, domain, { slug: "launch" })
    expect(linq.slug).toBe("launch")
  })

  test("refuses a slug already taken on the domain, archived ones included", async () => {
    const taken = await h.post("/api/v1/linqs", author.key, {
      domainId: domain,
      destination: "https://example.com/",
      slug: "launch",
    })
    expect(taken.status).toBe(409)

    // ADR 0002: archiving never releases a slug.
    const doomed = await h.createLinq(author.key, domain, { slug: "doomed" })
    await h.request(`/api/v1/linqs/${doomed.id}`, { key: author.key, method: "DELETE" })
    const reuse = await h.post("/api/v1/linqs", author.key, {
      domainId: domain,
      destination: "https://example.com/",
      slug: "doomed",
    })
    expect(reuse.status).toBe(409)
  })

  test("the same slug is free on a different domain", async () => {
    const other = await h.createDomain("other.test")
    const linq = await h.createLinq(author.key, other, { slug: "launch" })
    expect(linq.slug).toBe("launch")
  })

  test("rejects reserved slugs", async () => {
    for (const slug of ["api", "admin", "health", "robots.txt", "favicon.ico", "ADMIN"]) {
      const res = await h.post("/api/v1/linqs", author.key, {
        domainId: domain,
        destination: "https://example.com/",
        slug,
      })
      expect(res.status).toBe(400)
    }
  })

  test("rejects a malformed slug and a non-http destination", async () => {
    const badSlug = await h.post("/api/v1/linqs", author.key, {
      domainId: domain,
      destination: "https://example.com/",
      slug: "has spaces/and-slash",
    })
    expect(badSlug.status).toBe(400)

    const badDestination = await h.post("/api/v1/linqs", author.key, {
      domainId: domain,
      destination: "javascript:alert(1)",
    })
    expect(badDestination.status).toBe(400)
  })

  test("an unknown domain is a 404", async () => {
    const res = await h.post("/api/v1/linqs", author.key, {
      domainId: "00000000-0000-7000-8000-000000000000",
      destination: "https://example.com/",
    })
    expect(res.status).toBe(404)
  })

  test("lowercases tags", async () => {
    const linq = await h.createLinq(author.key, domain, { tags: ["Launch", "Q3"] })
    expect(linq.tags).toEqual(["launch", "q3"])
  })
})

describe("PATCH /api/v1/linqs/:id", () => {
  test("slug and domainId are immutable and rejected outright", async () => {
    const linq = await h.createLinq(author.key, domain)
    const other = await h.createDomain("immutable.test")

    expect((await h.patch(`/api/v1/linqs/${linq.id}`, author.key, { slug: "nope" })).status).toBe(
      400,
    )
    expect(
      (await h.patch(`/api/v1/linqs/${linq.id}`, author.key, { domainId: other })).status,
    ).toBe(400)

    const unchanged = await (
      await h.request(`/api/v1/linqs/${linq.id}`, { key: author.key })
    ).json()
    expect(unchanged.slug).toBe(linq.slug)
    expect(unchanged.domainId).toBe(domain)
  })

  test("an author edits its own linq but not another one", async () => {
    const mine = await h.createLinq(author.key, domain)
    const stranger = await h.actor("author")
    const theirs = await h.createLinq(stranger.key, domain)

    const ok = await h.patch(`/api/v1/linqs/${mine.id}`, author.key, {
      destination: "https://example.com/moved",
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ destination: "https://example.com/moved" })

    const denied = await h.patch(`/api/v1/linqs/${theirs.id}`, author.key, {
      destination: "https://example.com/hijack",
    })
    expect(denied.status).toBe(403)
  })

  test("an editor edits any linq", async () => {
    const editor = await h.actor("editor")
    const linq = await h.createLinq(author.key, domain)
    const res = await h.patch(`/api/v1/linqs/${linq.id}`, editor.key, { name: "Edited" })
    expect(res.status).toBe(200)
  })

  test("a viewer edits nothing", async () => {
    const viewer = await h.actor("viewer")
    const linq = await h.createLinq(author.key, domain)
    expect((await h.patch(`/api/v1/linqs/${linq.id}`, viewer.key, { name: "No" })).status).toBe(403)
  })
})

describe("ownership transfer", () => {
  test("an author hands over a linq it owns", async () => {
    const linq = await h.createLinq(author.key, domain)
    const recipient = await h.createUser({ role: "author", name: "Recipient" })

    const res = await h.patch(`/api/v1/linqs/${linq.id}`, author.key, { ownerId: recipient })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ownerId: recipient, ownerName: "Recipient" })
  })

  test("an editor may edit a linq it does not own but not reassign it", async () => {
    const editor = await h.actor("editor")
    const linq = await h.createLinq(author.key, domain)

    const res = await h.patch(`/api/v1/linqs/${linq.id}`, editor.key, { ownerId: editor.userId })
    expect(res.status).toBe(403)
  })

  test("an admin reassigns anything", async () => {
    const linq = await h.createLinq(author.key, domain)
    const res = await h.patch(`/api/v1/linqs/${linq.id}`, admin.key, { ownerId: admin.userId })
    expect(res.status).toBe(200)
  })

  test("transferring to an unknown user is a 404", async () => {
    const linq = await h.createLinq(author.key, domain)
    const res = await h.patch(`/api/v1/linqs/${linq.id}`, admin.key, {
      ownerId: "00000000-0000-7000-8000-000000000000",
    })
    expect(res.status).toBe(404)
  })
})

describe("archiving a linq", () => {
  test("DELETE archives, and archived can go back to active", async () => {
    const linq = await h.createLinq(author.key, domain)

    const archived = await h.request(`/api/v1/linqs/${linq.id}`, {
      key: author.key,
      method: "DELETE",
    })
    expect(archived.status).toBe(200)
    expect(await archived.json()).toMatchObject({ status: "archived" })

    const back = await h.patch(`/api/v1/linqs/${linq.id}`, author.key, { status: "active" })
    expect(await back.json()).toMatchObject({ status: "active" })
  })
})

describe("GET /api/v1/linqs", () => {
  test("hides archived linqs unless asked", async () => {
    const scoped = await h.createDomain("filters.test")
    const live = await h.createLinq(author.key, scoped, { slug: "live" })
    const dead = await h.createLinq(author.key, scoped, { slug: "dead" })
    await h.request(`/api/v1/linqs/${dead.id}`, { key: author.key, method: "DELETE" })

    const list = async (query: string) =>
      (
        await (
          await h.request(`/api/v1/linqs?domainId=${scoped}${query}`, { key: author.key })
        ).json()
      ).data as { id: string }[]

    expect((await list("")).map((l) => l.id)).toEqual([live.id])
    expect((await list("&status=archived")).map((l) => l.id)).toEqual([dead.id])
    expect((await list("&status=all")).map((l) => l.id).sort()).toEqual([live.id, dead.id].sort())
  })

  test("filters by tag, owner and search term", async () => {
    const scoped = await h.createDomain("search.test")
    const other = await h.actor("author")
    const tagged = await h.createLinq(author.key, scoped, {
      slug: "quarterly",
      tags: ["report"],
      name: "Quarterly report",
    })
    await h.createLinq(other.key, scoped, { slug: "misc", tags: ["other"] })

    const list = async (query: string) =>
      (
        await (
          await h.request(`/api/v1/linqs?domainId=${scoped}&${query}`, { key: author.key })
        ).json()
      ).data as { id: string }[]

    expect((await list("tags=report")).map((l) => l.id)).toEqual([tagged.id])
    expect((await list(`ownerId=${other.userId}`)).map((l) => l.id)).toHaveLength(1)
    expect((await list("search=quarter")).map((l) => l.id)).toEqual([tagged.id])
    expect((await list("search=QUARTERLY+REPORT")).map((l) => l.id)).toEqual([tagged.id])
    expect(await list("tags=nothing")).toHaveLength(0)
  })

  test("paginates and reports the matching total, not the page size", async () => {
    const scoped = await h.createDomain("paged.test")
    for (let i = 0; i < 3; i++) await h.createLinq(author.key, scoped, { slug: `p${i}` })

    const res = await h.request(`/api/v1/linqs?domainId=${scoped}&limit=2`, { key: author.key })
    const body = await res.json()
    expect(body.data).toHaveLength(2)
    expect(body).toMatchObject({ total: 3, limit: 2, offset: 0 })
  })

  test("rejects a limit above the cap", async () => {
    const res = await h.request("/api/v1/linqs?limit=500", { key: author.key })
    expect(res.status).toBe(400)
  })

  test("sorts by click count", async () => {
    const scoped = await h.createDomain("sorted.test")
    const cold = await h.createLinq(author.key, scoped, { slug: "cold" })
    const hot = await h.createLinq(author.key, scoped, { slug: "hot" })
    await h.recordClicks(hot.id, scoped, { human: 2, bot: 1 })
    await h.recordClicks(cold.id, scoped, { human: 1, bot: 0 })

    const res = await h.request(`/api/v1/linqs?domainId=${scoped}&sort=clicks`, { key: author.key })
    const body = await res.json()
    expect(body.data.map((l: { id: string }) => l.id)).toEqual([hot.id, cold.id])
    expect(body.data[0]).toMatchObject({ humanClicks: 2, botClicks: 1 })
  })
})

describe("GET /api/v1/tags", () => {
  // Tags are counted across the whole instance, so this needs a database of its own.
  test("counts tags over active linqs, most used first", async () => {
    const fresh = await createHarness()
    const owner = await fresh.actor("author")
    const scoped = await fresh.createDomain("tags.test")

    await fresh.createLinq(owner.key, scoped, { slug: "t1", tags: ["shared", "solo"] })
    await fresh.createLinq(owner.key, scoped, { slug: "t2", tags: ["shared"] })
    const archived = await fresh.createLinq(owner.key, scoped, { slug: "t3", tags: ["gone"] })
    await fresh.request(`/api/v1/linqs/${archived.id}`, { key: owner.key, method: "DELETE" })

    const tags = await (await fresh.request("/api/v1/tags", { key: owner.key })).json()
    expect(tags).toEqual([
      { tag: "shared", count: 2 },
      { tag: "solo", count: 1 },
    ])
  })
})
