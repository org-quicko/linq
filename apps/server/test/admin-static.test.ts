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

describe.skipIf(!built)("the exported Client UI at /home", () => {
  test("normalises /home to its trailing-slash form", async () => {
    const res = await h.request("/home")
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/home/")
  })

  test("serves the login shell at the root", async () => {
    const res = await h.request("/home/")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(await res.text()).toContain("<html")
  })

  test("serves a page both with and without its trailing slash", async () => {
    expect((await h.request("/home/links/")).status).toBe(200)
    expect((await h.request("/home/links")).status).toBe(200)
  })

  test("serves every exported page", async () => {
    for (const page of [
      "analytics",
      "archives",
      "settings/domains",
      "settings/keys",
      "links",
      "links/detail",
      // Redirect stubs (plans/Plan_27.md Parts C1–C4): still export a real
      // page, so they still serve 200 even though they only forward on.
      "overview",
      "visits",
      "orphans",
      "links/trash",
      "domains/trash",
      "domains",
      "settings",
      "links/new",
    ]) {
      const res = await h.request(`/home/${page}/`)
      expect(res.status).toBe(200)
    }
  })

  test("serves dynamic /links/:id/summary routes via the summary template", async () => {
    const res = await h.request("/home/links/0192384-abcd/summary/")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(await res.text()).toContain("<html")

    const resNoTrailing = await h.request("/home/links/0192384-abcd/summary")
    expect(resNoTrailing.status).toBe(200)
  })

  test("marks hashed assets immutable and HTML not", async () => {
    const chunks = join(adminRoot, "_next", "static", "chunks")
    const asset = readdirSync(chunks).find((name) => name.endsWith(".js"))
    expect(asset).toBeDefined()

    const js = await h.request(`/home/_next/static/chunks/${asset}`)
    expect(js.status).toBe(200)
    expect(js.headers.get("cache-control")).toContain("immutable")

    const html = await h.request("/home/")
    expect(html.headers.get("cache-control")).toBe("no-cache")
  })

  test("an unknown admin path is a 404, not the redirect handler", async () => {
    const res = await h.request("/home/nope/")
    expect(res.status).toBe(404)
  })

  test("refuses to serve anything outside the export directory", async () => {
    for (const path of [
      "/home/../package.json",
      "/home/%2e%2e/package.json",
      "/home/..%2fpackage.json",
      "/home/_next/../../../package.json",
    ]) {
      const res = await h.request(path)
      expect(res.status).not.toBe(200)
      expect(await res.text()).not.toContain('"name": "linq"')
    }
  })
})

describe("mounting order", () => {
  test("the API still answers even though /home is mounted", async () => {
    expect((await h.request("/api/health")).status).toBe(200)
  })
})
