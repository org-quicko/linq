import { beforeAll, describe, expect, test } from "bun:test"
import { createHarness, type Harness } from "./helpers/app.ts"

describe("the QR codes API", () => {
  let h: Harness
  let author: { keyId: string; key: string }
  let domain: string

  beforeAll(async () => {
    h = await createHarness()
    author = await h.actor("author")
    domain = await h.createDomain("qr.test")
  })

  describe("POST /v1/qr-codes", () => {
    test("creates one with defaults applied, echoing the link's shortUrl and metadata", async () => {
      const link = await h.createLink(author.key, domain)
      const res = await h.post("/api/v1/qr-codes", author.key, { linkId: link.id })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body).toMatchObject({
        linkId: link.id,
        dotColor: "#000000",
        bgColor: "#ffffff",
        pattern: "squares",
        shortUrl: link.shortUrl,
        linkName: link.name,
        slug: link.slug,
        domainHost: link.domainHost,
        linkStatus: "active",
      })
    })

    test("no linkId is a 400 — the always-attached rule at the API edge", async () => {
      const res = await h.post("/api/v1/qr-codes", author.key, {})
      expect(res.status).toBe(400)
    })

    test("an unknown linkId is a 404, even for a viewer", async () => {
      const missing = "00000000-0000-7000-8000-000000000000"
      expect((await h.post("/api/v1/qr-codes", author.key, { linkId: missing })).status).toBe(404)
      const viewer = await h.actor("viewer")
      expect((await h.post("/api/v1/qr-codes", viewer.key, { linkId: missing })).status).toBe(404)
    })

    test("permissions follow the link, not the QR code", async () => {
      const link = await h.createLink(author.key, domain)
      const stranger = await h.actor("author")
      const viewer = await h.actor("viewer")
      const manager = await h.actor("manager")

      expect((await h.post("/api/v1/qr-codes", stranger.key, { linkId: link.id })).status).toBe(403)
      expect((await h.post("/api/v1/qr-codes", viewer.key, { linkId: link.id })).status).toBe(403)
      expect((await h.post("/api/v1/qr-codes", manager.key, { linkId: link.id })).status).toBe(201)
    })

    test("rejects a bad hex color and an unknown pattern", async () => {
      const link = await h.createLink(author.key, domain)
      const cases = [
        { linkId: link.id, dotColor: "red" },
        { linkId: link.id, dotColor: "#12345" },
        { linkId: link.id, dotColor: "000000" },
        { linkId: link.id, pattern: "wavy" },
      ]
      for (const body of cases) {
        expect((await h.post("/api/v1/qr-codes", author.key, body)).status).toBe(400)
      }
    })

    test("an archived link is a 409 — the code would be born dead", async () => {
      const link = await h.createLink(author.key, domain)
      await h.request(`/api/v1/links/${link.id}`, { key: author.key, method: "DELETE" })
      expect((await h.post("/api/v1/qr-codes", author.key, { linkId: link.id })).status).toBe(409)
    })

    test("one link can carry more than one QR code", async () => {
      const link = await h.createLink(author.key, domain)
      await h.post("/api/v1/qr-codes", author.key, { linkId: link.id, name: "Poster" })
      await h.post("/api/v1/qr-codes", author.key, { linkId: link.id, name: "Flyer" })

      const res = await h.request(`/api/v1/qr-codes?linkId=${link.id}`, { key: author.key })
      const body = await res.json()
      expect(body.total).toBe(2)
    })
  })

  describe("GET /v1/qr-codes", () => {
    test("returns the page envelope and narrows by linkId", async () => {
      const linkA = await h.createLink(author.key, domain)
      const linkB = await h.createLink(author.key, domain)
      await h.post("/api/v1/qr-codes", author.key, { linkId: linkA.id })
      await h.post("/api/v1/qr-codes", author.key, { linkId: linkB.id })

      const all = await (await h.request("/api/v1/qr-codes", { key: author.key })).json()
      expect(all.total).toBeGreaterThanOrEqual(2)
      expect(all).toMatchObject({ limit: expect.any(Number), offset: expect.any(Number) })

      const scoped = await (
        await h.request(`/api/v1/qr-codes?linkId=${linkA.id}`, { key: author.key })
      ).json()
      expect(scoped.data.every((row: { linkId: string }) => row.linkId === linkA.id)).toBe(true)
    })

    test("search matches both the QR code's own name and its link's name and slug", async () => {
      const named = await h.createLink(author.key, domain, { name: "Campaign Launch" })
      const other = await h.createLink(author.key, domain, { slug: "distinct-slug-zzz" })
      await h.post("/api/v1/qr-codes", author.key, { linkId: named.id, name: "unrelated" })
      await h.post("/api/v1/qr-codes", author.key, { linkId: other.id, name: "unrelated" })

      const byLinkName = await (
        await h.request("/api/v1/qr-codes?search=Campaign+Launch", { key: author.key })
      ).json()
      expect(byLinkName.data.some((row: { linkId: string }) => row.linkId === named.id)).toBe(true)

      const bySlug = await (
        await h.request("/api/v1/qr-codes?search=distinct-slug-zzz", { key: author.key })
      ).json()
      expect(bySlug.total).toBe(1)
      expect(bySlug.data[0].linkId).toBe(other.id)
    })

    test("an unknown id is a 404, a malformed one a 400", async () => {
      const missing = "00000000-0000-7000-8000-000000000000"
      expect((await h.request(`/api/v1/qr-codes/${missing}`, { key: author.key })).status).toBe(404)
      expect((await h.request("/api/v1/qr-codes/not-a-uuid", { key: author.key })).status).toBe(400)
    })
  })

  describe("PATCH /v1/qr-codes/:id", () => {
    test("updates colours, pattern and name, and bumps updatedAt", async () => {
      const link = await h.createLink(author.key, domain)
      const created = await (
        await h.post("/api/v1/qr-codes", author.key, { linkId: link.id })
      ).json()

      const res = await h.patch(`/api/v1/qr-codes/${created.id}`, author.key, {
        name: "Storefront",
        dotColor: "#112233",
        bgColor: "#eeeeee",
        pattern: "rounded",
      })
      expect(res.status).toBe(200)
      const updated = await res.json()
      expect(updated).toMatchObject({
        name: "Storefront",
        dotColor: "#112233",
        bgColor: "#eeeeee",
        pattern: "rounded",
      })
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(created.updatedAt).getTime(),
      )
    })

    test("linkId in the body is a 400, and the row keeps pointing at the original link", async () => {
      const link = await h.createLink(author.key, domain)
      const other = await h.createLink(author.key, domain)
      const created = await (
        await h.post("/api/v1/qr-codes", author.key, { linkId: link.id })
      ).json()

      const res = await h.patch(`/api/v1/qr-codes/${created.id}`, author.key, {
        linkId: other.id,
      })
      expect(res.status).toBe(400)

      const reloaded = await (
        await h.request(`/api/v1/qr-codes/${created.id}`, { key: author.key })
      ).json()
      expect(reloaded.linkId).toBe(link.id)
    })

    test("an author on another key's link is refused", async () => {
      const link = await h.createLink(author.key, domain)
      const created = await (
        await h.post("/api/v1/qr-codes", author.key, { linkId: link.id })
      ).json()
      const stranger = await h.actor("author")

      expect(
        (await h.patch(`/api/v1/qr-codes/${created.id}`, stranger.key, { name: "x" })).status,
      ).toBe(403)
    })
  })

  describe("DELETE /v1/qr-codes/:id", () => {
    test("204s, then the row is gone from GET and from the list", async () => {
      const link = await h.createLink(author.key, domain)
      const created = await (
        await h.post("/api/v1/qr-codes", author.key, { linkId: link.id })
      ).json()

      const res = await h.request(`/api/v1/qr-codes/${created.id}`, {
        key: author.key,
        method: "DELETE",
      })
      expect(res.status).toBe(204)
      expect((await h.request(`/api/v1/qr-codes/${created.id}`, { key: author.key })).status).toBe(
        404,
      )

      const list = await (
        await h.request(`/api/v1/qr-codes?linkId=${link.id}`, { key: author.key })
      ).json()
      expect(list.data).toHaveLength(0)
    })

    test("the link itself is untouched: still active, still fetchable", async () => {
      const link = await h.createLink(author.key, domain)
      const created = await (
        await h.post("/api/v1/qr-codes", author.key, { linkId: link.id })
      ).json()
      await h.request(`/api/v1/qr-codes/${created.id}`, { key: author.key, method: "DELETE" })

      const res = await h.request(`/api/v1/links/${link.id}`, { key: author.key })
      expect(res.status).toBe(200)
      expect((await res.json()).status).toBe("active")
    })

    test("there is no purge route — ADR 0002's archive step was deliberately not extended here", async () => {
      const link = await h.createLink(author.key, domain)
      const created = await (
        await h.post("/api/v1/qr-codes", author.key, { linkId: link.id })
      ).json()
      const res = await h.request(`/api/v1/qr-codes/${created.id}/purge`, {
        key: author.key,
        method: "DELETE",
      })
      expect(res.status).toBe(404)
    })

    test("purging the parent link destroys its QR codes (ON DELETE CASCADE)", async () => {
      const admin = await h.actor("admin")
      const link = await h.createLink(author.key, domain)
      const created = await (
        await h.post("/api/v1/qr-codes", author.key, { linkId: link.id })
      ).json()

      await h.request(`/api/v1/links/${link.id}`, { key: author.key, method: "DELETE" })
      const purge = await h.request(`/api/v1/links/${link.id}/purge`, {
        key: admin.key,
        method: "DELETE",
      })
      expect(purge.status).toBe(204)

      expect((await h.request(`/api/v1/qr-codes/${created.id}`, { key: author.key })).status).toBe(
        404,
      )
    })
  })
})
