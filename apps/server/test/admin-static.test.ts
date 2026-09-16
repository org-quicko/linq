import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { adminRoot } from "../src/http/admin-static.ts"
import { createHarness, type Harness } from "./helpers/app.ts"

/** The export is a build artefact, so these only run once the UI has been built. */
const built = existsSync(join(adminRoot, "index.html"))

let h: Harness

beforeAll(async () => {
  h = await createHarness()
})

describe.skipIf(!built)("the exported Admin UI at /admin", () => {
  test("normalises /admin to its trailing-slash form", async () => {
    const res = await h.request("/admin")
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/admin/")
  })

  test("serves the login shell at the root", async () => {
    const res = await h.request("/admin/")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(await res.text()).toContain("<html")
  })

  test("serves a page both with and without its trailing slash", async () => {
    expect((await h.request("/admin/links/")).status).toBe(200)
    expect((await h.request("/admin/links")).status).toBe(200)
  })

  test("serves every exported page", async () => {
    for (const page of [
      "overview",
      "links",
      "links/new",
      "links/detail",
      "orphans",
      "settings",
      "settings/domains",
      "settings/users",
    ]) {
      const res = await h.request(`/admin/${page}/`)
      expect(res.status).toBe(200)
    }
  })

  test("marks hashed assets immutable and HTML not", async () => {
    const chunks = join(adminRoot, "_next", "static", "chunks")
    const asset = readdirSync(chunks).find((name) => name.endsWith(".js"))
    expect(asset).toBeDefined()

    const js = await h.request(`/admin/_next/static/chunks/${asset}`)
    expect(js.status).toBe(200)
    expect(js.headers.get("cache-control")).toContain("immutable")

    const html = await h.request("/admin/")
    expect(html.headers.get("cache-control")).toBe("no-cache")
  })

  test("an unknown admin path is a 404, not the redirect handler", async () => {
    const res = await h.request("/admin/nope/")
    expect(res.status).toBe(404)
  })

  test("refuses to serve anything outside the export directory", async () => {
    for (const path of [
      "/admin/../package.json",
      "/admin/%2e%2e/package.json",
      "/admin/..%2fpackage.json",
      "/admin/_next/../../../package.json",
    ]) {
      const res = await h.request(path)
      expect(res.status).not.toBe(200)
      expect(await res.text()).not.toContain('"name": "linq"')
    }
  })
})

describe("mounting order", () => {
  test("the API still answers even though /admin is mounted", async () => {
    expect((await h.request("/api/health")).status).toBe(200)
  })
})
