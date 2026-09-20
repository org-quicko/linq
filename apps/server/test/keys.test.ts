import { beforeAll, describe, expect, test } from "bun:test"
import { ROLES } from "@linq/shared"
import { createHarness, type Harness } from "./helpers/app.ts"

let h: Harness
let admin: { keyId: string; key: string }

beforeAll(async () => {
  h = await createHarness()
  admin = await h.actor("admin")
})

const post = (path: string, key: string, body: unknown) => h.post(path, key, body)
const patch = (path: string, key: string, body: unknown) => h.patch(path, key, body)

describe("GET /api/v1/keys", () => {
  test("shows every role the list, but only an admin sees role and prefix", async () => {
    const viewer = await h.actor("viewer")

    const asAdmin = await (await h.request("/api/v1/keys", { key: admin.key })).json()
    expect(asAdmin.data[0]).toHaveProperty("role")
    expect(asAdmin.data[0]).toHaveProperty("prefix")

    const asViewer = await (await h.request("/api/v1/keys", { key: viewer.key })).json()
    expect(asViewer.data[0]).toEqual({
      id: expect.any(String),
      name: expect.any(String),
      role: expect.any(String),
    })
    expect(asViewer.total).toBe(asAdmin.total)
  })

  test("every role may read the key list", async () => {
    for (const role of ROLES) {
      const actor = await h.actor(role)
      expect((await h.request("/api/v1/keys", { key: actor.key })).status).toBe(200)
    }
  })

  test("no response ever carries a secret or a hash", async () => {
    const body = await (await h.request("/api/v1/keys", { key: admin.key })).json()
    for (const key of body.data) {
      expect(key).not.toHaveProperty("secret")
      expect(key).not.toHaveProperty("keyHash")
    }
  })
})

describe("POST /api/v1/keys", () => {
  test("an admin mints a key and gets the secret exactly once", async () => {
    const res = await post("/api/v1/keys", admin.key, { name: "ops", role: "author" })
    expect(res.status).toBe(201)
    const minted = await res.json()

    expect(minted.secret).toStartWith("linq_")
    expect(minted.prefix).toBe(minted.secret.slice(0, 12))
    expect(minted).toMatchObject({ name: "ops", role: "author" })

    // The minted key authenticates as itself: there is no user behind it.
    const me = await (await h.request("/api/v1/me", { key: minted.secret })).json()
    expect(me).toMatchObject({ id: minted.id, name: "ops", role: "author" })

    // And it is never shown again.
    const fetched = await (await h.request(`/api/v1/keys/${minted.id}`, { key: admin.key })).json()
    expect(fetched).not.toHaveProperty("secret")
  })

  test("only an admin may mint", async () => {
    for (const role of ["viewer", "author", "manager"] as const) {
      const actor = await h.actor(role)
      const res = await post("/api/v1/keys", actor.key, { name: "nope", role: "viewer" })
      expect(res.status).toBe(403)
    }
  })

  test("rejects an unknown role with 400", async () => {
    const res = await post("/api/v1/keys", admin.key, { name: "bad", role: "root" })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("validation_failed")
  })
})

describe("PATCH /api/v1/keys/:id", () => {
  test("an admin renames and re-roles another key", async () => {
    const target = await h.createKey({ role: "viewer", name: "before" })
    const res = await patch(`/api/v1/keys/${target.keyId}`, admin.key, {
      name: "after",
      role: "manager",
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ name: "after", role: "manager" })
  })

  test("nobody changes the role of the key they are calling with", async () => {
    const res = await patch(`/api/v1/keys/${admin.keyId}`, admin.key, { role: "viewer" })
    expect(res.status).toBe(403)
  })

  test("but may rename it", async () => {
    const res = await patch(`/api/v1/keys/${admin.keyId}`, admin.key, { name: "root" })
    expect(res.status).toBe(200)
    expect((await res.json()).name).toBe("root")
  })

  test("demoting a link-owning key to viewer is refused with 409, and the role is unchanged", async () => {
    const domain = await h.createDomain("keys-demote.test")
    const owner = await h.createKey({ role: "author", name: "Owner" })
    await h.createLink(owner.key, domain)

    const res = await patch(`/api/v1/keys/${owner.keyId}`, admin.key, { role: "viewer" })
    expect(res.status).toBe(409)
    expect((await res.json()).error.message).toContain("1 link")

    const unchanged = await (
      await h.request(`/api/v1/keys/${owner.keyId}`, { key: admin.key })
    ).json()
    expect(unchanged.role).toBe("author")
  })

  test("demoting to manager or author still works: the rule is the ownership threshold, not the word viewer", async () => {
    const domain = await h.createDomain("keys-demote-manager.test")
    const owner = await h.createKey({ role: "author", name: "Owner2" })
    await h.createLink(owner.key, domain)

    expect(
      (await patch(`/api/v1/keys/${owner.keyId}`, admin.key, { role: "manager" })).status,
    ).toBe(200)
  })

  test("a key that owns nothing demotes to viewer freely", async () => {
    const target = await h.createKey({ role: "author", name: "Empty" })
    const res = await patch(`/api/v1/keys/${target.keyId}`, admin.key, { role: "viewer" })
    expect(res.status).toBe(200)
  })
})

describe("POST /api/v1/keys/:id/links/reassign", () => {
  test("reassigns to another key, and the demotion then succeeds", async () => {
    const domain = await h.createDomain("keys-reassign.test")
    const owner = await h.createKey({ role: "author", name: "Owner3" })
    const link = await h.createLink(owner.key, domain)
    const recipient = await h.createKey({ role: "author", name: "Recipient" })

    const res = await post(`/api/v1/keys/${owner.keyId}/links/reassign`, admin.key, {
      to: recipient.keyId,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ moved: 1 })

    const moved = await (await h.request(`/api/v1/links/${link.id}`, { key: admin.key })).json()
    expect(moved.ownerId).toBe(recipient.keyId)
    expect(moved.ownerName).toBe("Recipient")

    expect((await patch(`/api/v1/keys/${owner.keyId}`, admin.key, { role: "viewer" })).status).toBe(
      200,
    )
  })

  test("reassigns to null, and the demotion then succeeds", async () => {
    const domain = await h.createDomain("keys-reassign-null.test")
    const owner = await h.createKey({ role: "author", name: "Owner4" })
    const link = await h.createLink(owner.key, domain)

    const res = await post(`/api/v1/keys/${owner.keyId}/links/reassign`, admin.key, { to: null })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ moved: 1 })

    const unowned = await (await h.request(`/api/v1/links/${link.id}`, { key: admin.key })).json()
    expect(unowned.ownerId).toBeNull()

    expect((await patch(`/api/v1/keys/${owner.keyId}`, admin.key, { role: "viewer" })).status).toBe(
      200,
    )
  })

  test("reassigning to a viewer key is refused, same shape as the per-link transfer", async () => {
    const domain = await h.createDomain("keys-reassign-viewer.test")
    const owner = await h.createKey({ role: "author", name: "Owner5" })
    await h.createLink(owner.key, domain)
    const viewer = await h.createKey({ role: "viewer", name: "Viewer" })

    const res = await post(`/api/v1/keys/${owner.keyId}/links/reassign`, admin.key, {
      to: viewer.keyId,
    })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe("conflict")
  })

  test("reassigning to an unknown key is a 404", async () => {
    const owner = await h.createKey({ role: "author", name: "Owner6" })
    const res = await post(`/api/v1/keys/${owner.keyId}/links/reassign`, admin.key, {
      to: "00000000-0000-7000-8000-000000000000",
    })
    expect(res.status).toBe(404)
  })

  test("a non-admin author reassigns its own key's links but not another's", async () => {
    const domain = await h.createDomain("keys-reassign-self.test")
    const author = await h.createKey({ role: "author", name: "Self" })
    await h.createLink(author.key, domain)

    const own = await post(`/api/v1/keys/${author.keyId}/links/reassign`, author.key, { to: null })
    expect(own.status).toBe(200)

    const other = await h.createKey({ role: "author", name: "Other" })
    const forbidden = await post(`/api/v1/keys/${other.keyId}/links/reassign`, author.key, {
      to: null,
    })
    expect(forbidden.status).toBe(403)
  })
})

describe("DELETE /api/v1/keys/:id", () => {
  test("revoking a key stops it working", async () => {
    const target = await h.createKey({ role: "author" })
    expect((await h.request("/api/v1/me", { key: target.key })).status).toBe(200)

    const res = await h.request(`/api/v1/keys/${target.keyId}`, {
      key: admin.key,
      method: "DELETE",
    })
    expect(res.status).toBe(204)
    expect((await h.request("/api/v1/me", { key: target.key })).status).toBe(401)
  })

  test("revoking a link-owning key still succeeds and leaves its links unowned", async () => {
    // The 0011 guard rail B1 must not disturb: revocation stays unconditional
    // even though demotion no longer is.
    const domain = await h.createDomain("keys-revoke-links.test")
    const owner = await h.createKey({ role: "author", name: "Revoked" })
    const link = await h.createLink(owner.key, domain)

    const res = await h.request(`/api/v1/keys/${owner.keyId}`, {
      key: admin.key,
      method: "DELETE",
    })
    expect(res.status).toBe(204)

    const after = await (await h.request(`/api/v1/links/${link.id}`, { key: admin.key })).json()
    expect(after.ownerId).toBeNull()
  })

  test("nobody revokes the key they are calling with", async () => {
    const res = await h.request(`/api/v1/keys/${admin.keyId}`, {
      key: admin.key,
      method: "DELETE",
    })
    expect(res.status).toBe(403)
    // Still working, which is the point of the guard.
    expect((await h.request("/api/v1/me", { key: admin.key })).status).toBe(200)
  })

  test("a non-admin may not revoke", async () => {
    const manager = await h.actor("manager")
    const target = await h.createKey({ role: "viewer" })
    const res = await h.request(`/api/v1/keys/${target.keyId}`, {
      key: manager.key,
      method: "DELETE",
    })
    expect(res.status).toBe(403)
  })

  test("revoking an unknown key is a 404", async () => {
    const res = await h.request("/api/v1/keys/00000000-0000-7000-8000-000000000000", {
      key: admin.key,
      method: "DELETE",
    })
    expect(res.status).toBe(404)
  })
})
