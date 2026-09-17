import { beforeAll, describe, expect, test } from "bun:test"
import { ROLES, type Role } from "@linq/shared"
import { createHarness, type Harness } from "./helpers/app.ts"

let h: Harness
let admin: { userId: string; key: string }

beforeAll(async () => {
  h = await createHarness()
  admin = await h.actor("admin")
})

const post = (path: string, key: string, body: unknown) =>
  h.request(path, { key, method: "POST", body: JSON.stringify(body) })

const patch = (path: string, key: string, body: unknown) =>
  h.request(path, { key, method: "PATCH", body: JSON.stringify(body) })

describe("GET /api/v1/users", () => {
  test("shows every role the list, but only admins see role and email", async () => {
    const viewer = await h.actor("viewer")
    const asAdmin = await (await h.request("/api/v1/users", { key: admin.key })).json()
    const asViewer = await (await h.request("/api/v1/users", { key: viewer.key })).json()

    expect(asAdmin.data[0]).toHaveProperty("role")
    expect(asViewer.data[0]).toEqual({ id: expect.any(String), name: expect.any(String) })
    expect(asViewer.total).toBe(asAdmin.total)
  })
})

describe("POST /api/v1/users", () => {
  test("only an admin may create users", async () => {
    for (const role of ["viewer", "author", "manager"] as Role[]) {
      const { key } = await h.actor(role)
      const res = await post("/api/v1/users", key, { name: role, role: "viewer" })
      expect(res.status).toBe(403)
    }
  })

  test("creates a user", async () => {
    const res = await post("/api/v1/users", admin.key, {
      name: "Dana",
      email: "dana@example.com",
      role: "author",
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ name: "Dana", role: "author", status: "active" })
  })

  test("refuses a duplicate email with 409", async () => {
    const res = await post("/api/v1/users", admin.key, {
      name: "Other Dana",
      email: "dana@example.com",
      role: "viewer",
    })
    expect(res.status).toBe(409)
  })

  test("rejects an unknown role with 400", async () => {
    const res = await post("/api/v1/users", admin.key, { name: "X", role: "root" })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("validation_failed")
  })
})

describe("PATCH /api/v1/users/:id", () => {
  test("an admin may change the role of another user", async () => {
    const target = await h.createUser({ role: "viewer", name: "Target" })
    const res = await patch(`/api/v1/users/${target}`, admin.key, { role: "manager" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ role: "manager" })
  })

  test("nobody changes their own role", async () => {
    const res = await patch(`/api/v1/users/${admin.userId}`, admin.key, { role: "viewer" })
    expect(res.status).toBe(403)
  })

  test("but may change their own name", async () => {
    const res = await patch(`/api/v1/users/${admin.userId}`, admin.key, { name: "Root" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ name: "Root" })
  })

  test("nobody disables themselves", async () => {
    const res = await patch(`/api/v1/users/${admin.userId}`, admin.key, { status: "disabled" })
    expect(res.status).toBe(403)
    expect((await h.request("/api/v1/me", { key: admin.key })).status).toBe(200)
  })

  test("disabling a user kills its keys immediately", async () => {
    const victim = await h.actor("manager")
    expect((await h.request("/api/v1/me", { key: victim.key })).status).toBe(200)

    await patch(`/api/v1/users/${victim.userId}`, admin.key, { status: "disabled" })
    expect((await h.request("/api/v1/me", { key: victim.key })).status).toBe(401)
  })
})

describe("keys", () => {
  test("an admin mints a key and gets the secret exactly once", async () => {
    const target = await h.createUser({ role: "author", name: "Keyed" })
    const res = await post(`/api/v1/users/${target}/keys`, admin.key, { label: "ci" })
    expect(res.status).toBe(201)
    const created = await res.json()
    expect(created.secret).toStartWith("linq_")
    expect(created.prefix).toBe(created.secret.slice(0, 12))

    const listed = await (
      await h.request(`/api/v1/users/${target}/keys`, { key: admin.key })
    ).json()
    expect(listed).toHaveLength(1)
    expect(listed[0]).not.toHaveProperty("secret")

    // The minted key authenticates as its owner.
    const me = await (await h.request("/api/v1/me", { key: created.secret })).json()
    expect(me.user.id).toBe(target)
  })

  test("a non-admin may not mint or revoke keys", async () => {
    const manager = await h.actor("manager")
    const mint = await post(`/api/v1/users/${manager.userId}/keys`, manager.key, { label: "x" })
    expect(mint.status).toBe(403)

    const revoke = await h.request("/api/v1/keys/00000000-0000-7000-8000-000000000000", {
      key: manager.key,
      method: "DELETE",
    })
    expect(revoke.status).toBe(403)
  })

  test("revoking a key stops it working", async () => {
    const target = await h.createUser({ role: "viewer", name: "Revoked" })
    const minted = await post(`/api/v1/users/${target}/keys`, admin.key, { label: "temp" })
    const created = await minted.json()
    expect((await h.request("/api/v1/me", { key: created.secret })).status).toBe(200)

    const del = await h.request(`/api/v1/keys/${created.id}`, { key: admin.key, method: "DELETE" })
    expect(del.status).toBe(204)
    expect((await h.request("/api/v1/me", { key: created.secret })).status).toBe(401)
  })

  test("minting a key for an unknown user is a 404", async () => {
    const res = await post("/api/v1/users/00000000-0000-7000-8000-000000000000/keys", admin.key, {
      label: "x",
    })
    expect(res.status).toBe(404)
  })
})

describe("read access", () => {
  test("every role may read the user list", async () => {
    for (const role of ROLES) {
      const { key } = await h.actor(role)
      expect((await h.request("/api/v1/users", { key })).status).toBe(200)
    }
  })
})
