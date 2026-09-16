import { beforeAll, describe, expect, test } from "bun:test"
import { createHarness, type Harness } from "./helpers/app.ts"

/**
 * The Client UI can be served from a different origin than the server it talks
 * to, so every API call it makes is cross-origin. `Authorization` is never a
 * simple header, which means the browser sends a preflight first: if that is
 * not answered, nothing the UI does reaches the server at all.
 */

const ORIGIN = "https://admin.example.test"

let h: Harness
let key: string

beforeAll(async () => {
  h = await createHarness()
  key = (await h.actor("admin")).key
})

describe("CORS on /api", () => {
  test("answers the preflight an authorised cross-origin call triggers", async () => {
    const res = await h.request("/api/v1/links", {
      method: "OPTIONS",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,content-type",
      },
    })

    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe("*")

    // Whatever the browser asked to send must come back as allowed, or it
    // withholds the header and the real request arrives unauthenticated.
    const allowed = res.headers.get("access-control-allow-headers")?.toLowerCase() ?? ""
    expect(allowed).toContain("authorization")
    expect(allowed).toContain("content-type")
  })

  test("allows the methods the UI actually uses", async () => {
    const res = await h.request("/api/v1/links", {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "PATCH" },
    })

    const methods = res.headers.get("access-control-allow-methods")?.toUpperCase() ?? ""
    for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE"]) {
      expect(methods).toContain(method)
    }
  })

  test("marks the real response as readable by the calling origin", async () => {
    const res = await h.request("/api/v1/links", { key, headers: { origin: ORIGIN } })

    expect(res.status).toBe(200)
    expect(res.headers.get("access-control-allow-origin")).toBe("*")
  })

  test("covers the unauthenticated health probe, which is how a server is added", async () => {
    const res = await h.request("/api/health", { headers: { origin: ORIGIN } })

    expect(res.status).toBe(200)
    expect(res.headers.get("access-control-allow-origin")).toBe("*")
    expect(await res.json()).toMatchObject({ status: "ok" })
  })

  test("still rejects a cross-origin call carrying no key", async () => {
    // CORS is not authentication: an allowed origin still has to present a key.
    const res = await h.request("/api/v1/links", { headers: { origin: ORIGIN } })
    expect(res.status).toBe(401)
  })

  test("leaves redirects alone", async () => {
    // A redirect is a top-level navigation, not a fetch, so it needs no CORS
    // header and must not start emitting one.
    const domainId = await h.createDomain("localhost")
    const link = await h.createLink(key, domainId, {
      slug: "cors1",
      destination: "https://example.com/",
    })
    expect(link.slug).toBe("cors1")

    const res = await h.request("/cors1", { headers: { origin: ORIGIN } })
    expect(res.status).toBe(302)
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })
})
