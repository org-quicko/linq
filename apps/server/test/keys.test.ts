import { describe, expect, test } from "bun:test"
import { claimsForPreset } from "@linq/shared"
import { createHarness } from "./helpers/app.ts"

describe("API keys", () => {
  test("an admin-preset key mints and returns a claims-only key", async () => {
    const h = await createHarness()
    const admin = await h.actor("admin")
    const res = await h.post("/api/v1/keys", admin.key, { name: "ops", preset: "editor" })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({
      name: "ops",
      preset: "editor",
      claims: [...claimsForPreset.editor],
    })
  })
  test("accepts a least-privilege custom claim set and rejects unknown claims", async () => {
    const h = await createHarness()
    const admin = await h.actor("admin")
    const allowed = await h.post("/api/v1/keys", admin.key, {
      name: "domain-bot",
      claims: [{ action: "create", subject: "Domain" }],
    })
    expect(allowed.status).toBe(201)
    expect(await allowed.json()).toMatchObject({
      preset: null,
      claims: [{ action: "create", subject: "Domain" }],
    })
    const denied = await h.post("/api/v1/keys", admin.key, {
      name: "bad",
      claims: [{ action: "manage", subject: "Key" }],
    })
    expect(denied.status).toBe(400)
  })
  test("viewers and editors may list key summaries but cannot modify keys", async () => {
    const h = await createHarness()
    const target = await h.createKey({ preset: "admin", name: "ops" })

    for (const preset of ["viewer", "editor"] as const) {
      const actor = await h.actor(preset)
      const listed = await h.request("/api/v1/keys", { key: actor.key })
      expect(listed.status).toBe(200)
      const keys = (await listed.json()).data
      expect(keys).toContainEqual({
        id: target.keyId,
        name: "ops",
        claims: [...claimsForPreset.admin],
        preset: "admin",
      })

      expect(
        (await h.post("/api/v1/keys", actor.key, { name: "nope", preset: "viewer" })).status,
      ).toBe(403)
      expect(
        (await h.patch(`/api/v1/keys/${target.keyId}`, actor.key, { name: "nope" })).status,
      ).toBe(403)
      expect(
        (await h.request(`/api/v1/keys/${target.keyId}`, { key: actor.key, method: "DELETE" }))
          .status,
      ).toBe(403)
    }
  })
  test("a key cannot change or revoke itself", async () => {
    const h = await createHarness()
    const admin = await h.actor("admin")
    const patch = await h.patch(`/api/v1/keys/${admin.keyId}`, admin.key, { preset: "viewer" })
    expect(patch.status).toBe(403)
    const del = await h.request(`/api/v1/keys/${admin.keyId}`, { key: admin.key, method: "DELETE" })
    expect(del.status).toBe(403)
  })
})
