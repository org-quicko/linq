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
      // Redirect stubs: still export a real page, so they still serve 200
      // even though they only forward on.
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

  test("marks hashed assets immutable and HTML not", async () => {
    const chunks = join(adminRoot, "_next", "static", "chunks")
    const asset = readdirSync(chunks).find((name) => name.endsWith(".js"))
    expect(asset).toBeDefined()

    const js = await h.request(`/home/_next/static/chunks/${asset}`)
    expect(js.status).toBe(200)
    expect(js.headers.get("cache-control")).toContain("immutable")

    const html = await h.request("/home/")
    expect(html.headers.get("cache-control")).toBe("no-cache")
    const csp = html.headers.get("content-security-policy") ?? ""
    expect(csp).toContain("script-src 'self' 'sha256-")
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(html.headers.get("x-frame-options")).toBe("DENY")
    expect(html.headers.get("x-content-type-options")).toBe("nosniff")
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

  test("mounts the Client UI at a configured multi-segment path", async () => {
    const custom = await createHarness({ config: { LINQ_CLIENT_BASE_PATH: "/admin/example" } })
    const res = await custom.request("/admin/example")
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/admin/example/")
    expect((await custom.request("/admin/example/nope")).status).toBe(404)
  })
})

describe("a root mount on LINQ_APP_HOST", () => {
  const APP = "app.test"
  const LINKS = "links.test"
  let root: Harness
  let slug: string

  beforeAll(async () => {
    root = await createHarness({ config: { LINQ_CLIENT_BASE_PATH: "/", LINQ_APP_HOST: APP } })
    const { key } = await root.actor("editor")
    const domain = await root.createDomain(LINKS)
    slug = (await root.createLink(key, domain, { destination: "https://example.com/" })).slug
  })

  test("a slug redirects on a shortening domain but belongs to the UI on the app host", async () => {
    const link = await root.request(`/${slug}`, { host: LINKS })
    expect(link.status).toBe(302)
    expect(link.headers.get("location")).toBe("https://example.com/")
    expect((await root.request(`/${slug}`, { host: APP })).status).not.toBe(302)
  })

  test("the API answers on the app host", async () => {
    expect((await root.request("/api/health", { host: APP })).status).toBe(200)
  })

  test("an unregistered host's root points at the app host", async () => {
    const res = await root.request("/", { host: "nobody.test" })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(`https://${APP}/`)
  })

  test("robots.txt keeps crawlers off the app host only", async () => {
    expect(await (await root.request("/robots.txt", { host: APP })).text()).toContain(
      "Disallow: /\n",
    )
    expect(await (await root.request("/robots.txt", { host: LINKS })).text()).not.toContain(
      "Disallow: /\n",
    )
  })

  test("the app host cannot be registered as a domain", async () => {
    const { key } = await root.actor("admin")
    expect((await root.post("/api/v1/domains", key, { host: APP })).status).toBe(400)
  })
})

describe.skipIf(!built)("the exported Client UI at / on LINQ_APP_HOST", () => {
  test("serves the UI at the app host's root", async () => {
    const root = await createHarness({
      config: { LINQ_CLIENT_BASE_PATH: "/", LINQ_APP_HOST: "app.test" },
    })
    const res = await root.request("/", { host: "app.test" })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("<html")
  })
})
