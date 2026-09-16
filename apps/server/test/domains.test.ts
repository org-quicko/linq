import { beforeAll, describe, expect, test } from "bun:test"
import { createHarness, type Harness } from "./helpers/app.ts"

let h: Harness
let admin: { userId: string; key: string }

beforeAll(async () => {
  h = await createHarness()
  admin = await h.actor("admin")
})

describe("POST /api/v1/domains", () => {
  test("only an admin creates domains", async () => {
    const editor = await h.actor("editor")
    const res = await h.post("/api/v1/domains", editor.key, { host: "nope.test" })
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

  test("counts only active links", async () => {
    const domain = await h.createDomain("counted.test")
    const author = await h.actor("author")
    const kept = await h.createLink(author.key, domain, { slug: "kept" })
    await h.createLink(author.key, domain, { slug: "dropped" })

    const before = await (await h.request(`/api/v1/domains/${domain}`, { key: admin.key })).json()
    expect(before.linkCount).toBe(2)

    await h.request(`/api/v1/links/${kept.id}`, { key: author.key, method: "DELETE" })
    const after = await (await h.request(`/api/v1/domains/${domain}`, { key: admin.key })).json()
    expect(after.linkCount).toBe(1)
  })
})

describe("archiving a domain", () => {
  test("is refused with 409 while an active link exists", async () => {
    const domain = await h.createDomain("busy.test")
    const author = await h.actor("author")
    const link = await h.createLink(author.key, domain, { slug: "busy" })

    const viaDelete = await h.request(`/api/v1/domains/${domain}`, {
      key: admin.key,
      method: "DELETE",
    })
    expect(viaDelete.status).toBe(409)

    const viaPatch = await h.patch(`/api/v1/domains/${domain}`, admin.key, { status: "archived" })
    expect(viaPatch.status).toBe(409)

    // Archiving the last active link clears the way.
    await h.request(`/api/v1/links/${link.id}`, { key: author.key, method: "DELETE" })
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

describe("PATCH /api/v1/domains/:id", () => {
  test("only an admin may change a fallback", async () => {
    const domain = await h.createDomain("fallback.test")
    const editor = await h.actor("editor")
    expect(
      (await h.patch(`/api/v1/domains/${domain}`, editor.key, { fallbackUrl: null })).status,
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
