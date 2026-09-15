import { beforeAll, describe, expect, test } from "bun:test"
import { createHarness, type Harness } from "./helpers/app.ts"

let h: Harness

beforeAll(async () => {
  h = await createHarness()
})

describe("GET /api/health", () => {
  test("is unauthenticated", async () => {
    const res = await h.request("/api/health")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: "ok" })
  })
})

describe("authentication", () => {
  test("rejects a request with no key", async () => {
    const res = await h.request("/api/v1/me")
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe("unauthorized")
  })

  test("rejects an unknown key", async () => {
    const res = await h.request("/api/v1/me", { key: "linq_nope" })
    expect(res.status).toBe(401)
  })

  test("accepts a valid key and reports the principal", async () => {
    const { userId, key } = await h.actor("editor")
    const res = await h.request("/api/v1/me", { key })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user).toMatchObject({ id: userId, role: "editor" })
    expect(body.keyPrefix).toBe(key.slice(0, 12))
  })

  test("accepts the X-Api-Key fallback header", async () => {
    const { key } = await h.actor("viewer")
    const res = await h.request("/api/v1/me", { headers: { "x-api-key": key } })
    expect(res.status).toBe(200)
  })

  test("rejects an expired key", async () => {
    const userId = await h.createUser({ role: "admin" })
    const key = await h.createKey(userId, { expiresAt: new Date(Date.now() - 1000) })
    const res = await h.request("/api/v1/me", { key })
    expect(res.status).toBe(401)
    expect((await res.json()).error.message).toContain("expired")
  })

  test("rejects every key of a disabled user", async () => {
    const userId = await h.createUser({ role: "admin", status: "disabled" })
    const key = await h.createKey(userId)
    const res = await h.request("/api/v1/me", { key })
    expect(res.status).toBe(401)
    expect((await res.json()).error.message).toContain("disabled")
  })
})
