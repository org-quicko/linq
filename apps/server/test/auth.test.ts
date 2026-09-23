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
    const { keyId, key } = await h.actor("editor")
    const res = await h.request("/api/v1/me", { key })
    expect(res.status).toBe(200)
    // /me is the key itself: there is no user behind it.
    expect(await res.json()).toMatchObject({
      id: keyId,
      role: "editor",
      prefix: key.slice(0, 12),
    })
  })

  test("accepts the X-Api-Key fallback header", async () => {
    const { key } = await h.actor("viewer")
    const res = await h.request("/api/v1/me", { headers: { "x-api-key": key } })
    expect(res.status).toBe(200)
  })

  test("rejects an expired key", async () => {
    const { key } = await h.createKey({ role: "admin", expires_at: new Date(Date.now() - 1000) })
    const res = await h.request("/api/v1/me", { key })
    expect(res.status).toBe(401)
    expect((await res.json()).error.message).toContain("expired")
  })
})

describe("API request limits", () => {
  test("limits a verified key and gives callers a retry time", async () => {
    const limited = await createHarness({ config: { LINQ_API_RATE_LIMIT_PER_MINUTE: 2 } })
    const key = (await limited.actor("viewer")).key

    expect((await limited.request("/api/v1/me", { key })).status).toBe(200)
    expect((await limited.request("/api/v1/me", { key })).status).toBe(200)
    const blocked = await limited.request("/api/v1/me", { key })

    expect(blocked.status).toBe(429)
    expect(blocked.headers.get("retry-after")).toBeTruthy()
    expect(await blocked.json()).toMatchObject({
      error: { code: "rate_limited", message: "API rate limit exceeded" },
    })
  })

  test("rejects oversized API bodies before parsing them", async () => {
    const key = (await h.actor("editor")).key
    const res = await h.request("/api/v1/links", {
      key,
      method: "POST",
      body: "x".repeat(1_000_001),
      headers: { "content-type": "application/json" },
    })

    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({
      error: { code: "validation_failed", message: "request body exceeds 1 MB" },
    })
  })
})
