import { beforeAll, describe, expect, test } from "bun:test"
import { createHarness, type Harness } from "./helpers/app.ts"

describe("the QR codes API", () => {
  let h: Harness
  let editor: { keyId: string; key: string }
  let domain: string

  beforeAll(async () => {
    h = await createHarness()
    editor = await h.actor("editor")
    domain = await h.createDomain("qr.test")
  })

  describe("POST /v1/qr-codes", () => {
    test("creates one with defaults applied, echoing the link's short_url and metadata", async () => {
      const link = await h.createLink(editor.key, domain)
      const res = await h.post("/api/v1/qr-codes", editor.key, { link_id: link.id })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body).toMatchObject({
        link_id: link.id,
        dot_color: "#000000",
        bg_color: "#ffffff",
        pattern: "squares",
        short_url: link.short_url,
        link_name: link.name,
        slug: link.slug,
        domain_host: link.domain_host,
        link_status: "active",
      })
    })

    test("no link_id is a 400 — the always-attached rule at the API edge", async () => {
      const res = await h.post("/api/v1/qr-codes", editor.key, {})
      expect(res.status).toBe(400)
    })

    test("an unknown link_id is a 404, even for a viewer", async () => {
      const missing = "00000000-0000-7000-8000-000000000000"
      expect((await h.post("/api/v1/qr-codes", editor.key, { link_id: missing })).status).toBe(404)
      const viewer = await h.actor("viewer")
      expect((await h.post("/api/v1/qr-codes", viewer.key, { link_id: missing })).status).toBe(404)
    })

    test("permissions are role-only: any editor, not just whoever created the link", async () => {
      const link = await h.createLink(editor.key, domain)
      const otherEditor = await h.actor("editor")
      const viewer = await h.actor("viewer")

      expect((await h.post("/api/v1/qr-codes", viewer.key, { link_id: link.id })).status).toBe(403)
      expect((await h.post("/api/v1/qr-codes", otherEditor.key, { link_id: link.id })).status).toBe(
        201,
      )
    })

    test("rejects a bad hex color and an unknown pattern", async () => {
      const link = await h.createLink(editor.key, domain)
      const cases = [
        { link_id: link.id, dot_color: "red" },
        { link_id: link.id, dot_color: "#12345" },
        { link_id: link.id, dot_color: "000000" },
        { link_id: link.id, pattern: "wavy" },
      ]
      for (const body of cases) {
        expect((await h.post("/api/v1/qr-codes", editor.key, body)).status).toBe(400)
      }
    })

    test("an archived link is a 409 — the code would be born dead", async () => {
      const link = await h.createLink(editor.key, domain)
      const admin = await h.actor("admin")
      await h.request(`/api/v1/links/${link.id}`, { key: admin.key, method: "DELETE" })
      expect((await h.post("/api/v1/qr-codes", editor.key, { link_id: link.id })).status).toBe(409)
    })

    test("one link can carry more than one QR code", async () => {
      const link = await h.createLink(editor.key, domain)
      await h.post("/api/v1/qr-codes", editor.key, { link_id: link.id, name: "Poster" })
      await h.post("/api/v1/qr-codes", editor.key, { link_id: link.id, name: "Flyer" })

      const res = await h.request(`/api/v1/qr-codes?link_id=${link.id}`, { key: editor.key })
      const body = await res.json()
      expect(body.total).toBe(2)
    })
  })

  describe("GET /v1/qr-codes", () => {
    test("returns the page envelope and narrows by link_id", async () => {
      const linkA = await h.createLink(editor.key, domain)
      const linkB = await h.createLink(editor.key, domain)
      await h.post("/api/v1/qr-codes", editor.key, { link_id: linkA.id })
      await h.post("/api/v1/qr-codes", editor.key, { link_id: linkB.id })

      const all = await (await h.request("/api/v1/qr-codes", { key: editor.key })).json()
      expect(all.total).toBeGreaterThanOrEqual(2)
      expect(all).toMatchObject({ limit: expect.any(Number), offset: expect.any(Number) })

      const scoped = await (
        await h.request(`/api/v1/qr-codes?link_id=${linkA.id}`, { key: editor.key })
      ).json()
      expect(scoped.data.every((row: { link_id: string }) => row.link_id === linkA.id)).toBe(true)
    })

    test("search matches both the QR code's own name and its link's name and slug", async () => {
      const named = await h.createLink(editor.key, domain, { name: "Campaign Launch" })
      const other = await h.createLink(editor.key, domain, { slug: "distinct-slug-zzz" })
      await h.post("/api/v1/qr-codes", editor.key, { link_id: named.id, name: "unrelated" })
      await h.post("/api/v1/qr-codes", editor.key, { link_id: other.id, name: "unrelated" })

      const byLinkName = await (
        await h.request("/api/v1/qr-codes?search=Campaign+Launch", { key: editor.key })
      ).json()
      expect(byLinkName.data.some((row: { link_id: string }) => row.link_id === named.id)).toBe(true)

      const bySlug = await (
        await h.request("/api/v1/qr-codes?search=distinct-slug-zzz", { key: editor.key })
      ).json()
      expect(bySlug.total).toBe(1)
      expect(bySlug.data[0].link_id).toBe(other.id)
    })

    test("an unknown id is a 404, a malformed one a 400", async () => {
      const missing = "00000000-0000-7000-8000-000000000000"
      expect((await h.request(`/api/v1/qr-codes/${missing}`, { key: editor.key })).status).toBe(404)
      expect((await h.request("/api/v1/qr-codes/not-a-uuid", { key: editor.key })).status).toBe(400)
    })
  })

  describe("PATCH /v1/qr-codes/:id", () => {
    test("updates colours, pattern and name, and bumps updated_at", async () => {
      const link = await h.createLink(editor.key, domain)
      const created = await (
        await h.post("/api/v1/qr-codes", editor.key, { link_id: link.id })
      ).json()

      const res = await h.patch(`/api/v1/qr-codes/${created.id}`, editor.key, {
        name: "Storefront",
        dot_color: "#112233",
        bg_color: "#eeeeee",
        pattern: "rounded",
      })
      expect(res.status).toBe(200)
      const updated = await res.json()
      expect(updated).toMatchObject({
        name: "Storefront",
        dot_color: "#112233",
        bg_color: "#eeeeee",
        pattern: "rounded",
      })
      expect(new Date(updated.updated_at).getTime()).toBeGreaterThanOrEqual(
        new Date(created.updated_at).getTime(),
      )
    })

    test("link_id in the body is a 400, and the row keeps pointing at the original link", async () => {
      const link = await h.createLink(editor.key, domain)
      const other = await h.createLink(editor.key, domain)
      const created = await (
        await h.post("/api/v1/qr-codes", editor.key, { link_id: link.id })
      ).json()

      const res = await h.patch(`/api/v1/qr-codes/${created.id}`, editor.key, {
        link_id: other.id,
      })
      expect(res.status).toBe(400)

      const reloaded = await (
        await h.request(`/api/v1/qr-codes/${created.id}`, { key: editor.key })
      ).json()
      expect(reloaded.link_id).toBe(link.id)
    })

    test("any editor may patch another key's link's QR code — links have no owner", async () => {
      const link = await h.createLink(editor.key, domain)
      const created = await (
        await h.post("/api/v1/qr-codes", editor.key, { link_id: link.id })
      ).json()
      const otherEditor = await h.actor("editor")

      expect(
        (await h.patch(`/api/v1/qr-codes/${created.id}`, otherEditor.key, { name: "x" })).status,
      ).toBe(200)
    })
  })

  describe("DELETE /v1/qr-codes/:id", () => {
    test("204s, then the row is gone from GET and from the list", async () => {
      const link = await h.createLink(editor.key, domain)
      const created = await (
        await h.post("/api/v1/qr-codes", editor.key, { link_id: link.id })
      ).json()

      const res = await h.request(`/api/v1/qr-codes/${created.id}`, {
        key: editor.key,
        method: "DELETE",
      })
      expect(res.status).toBe(204)
      expect((await h.request(`/api/v1/qr-codes/${created.id}`, { key: editor.key })).status).toBe(
        404,
      )

      const list = await (
        await h.request(`/api/v1/qr-codes?link_id=${link.id}`, { key: editor.key })
      ).json()
      expect(list.data).toHaveLength(0)
    })

    test("the link itself is untouched: still active, still fetchable", async () => {
      const link = await h.createLink(editor.key, domain)
      const created = await (
        await h.post("/api/v1/qr-codes", editor.key, { link_id: link.id })
      ).json()
      await h.request(`/api/v1/qr-codes/${created.id}`, { key: editor.key, method: "DELETE" })

      const res = await h.request(`/api/v1/links/${link.id}`, { key: editor.key })
      expect(res.status).toBe(200)
      expect((await res.json()).status).toBe("active")
    })

    test("there is no purge route — ADR 0002's archive step was deliberately not extended here", async () => {
      const link = await h.createLink(editor.key, domain)
      const created = await (
        await h.post("/api/v1/qr-codes", editor.key, { link_id: link.id })
      ).json()
      const res = await h.request(`/api/v1/qr-codes/${created.id}/purge`, {
        key: editor.key,
        method: "DELETE",
      })
      expect(res.status).toBe(404)
    })

    test("purging the parent link destroys its QR codes (ON DELETE CASCADE)", async () => {
      const admin = await h.actor("admin")
      const link = await h.createLink(editor.key, domain)
      const created = await (
        await h.post("/api/v1/qr-codes", editor.key, { link_id: link.id })
      ).json()

      await h.request(`/api/v1/links/${link.id}`, { key: admin.key, method: "DELETE" })
      const purge = await h.request(`/api/v1/links/${link.id}/purge`, {
        key: admin.key,
        method: "DELETE",
      })
      expect(purge.status).toBe(204)

      expect((await h.request(`/api/v1/qr-codes/${created.id}`, { key: editor.key })).status).toBe(
        404,
      )
    })
  })
})
