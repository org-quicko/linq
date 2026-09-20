import { beforeAll, describe, expect, test } from "bun:test"
import { memoryCache } from "../src/cache.ts"
import { renderLlms } from "../src/http/llms.ts"
import { createHarness, type Harness } from "./helpers/app.ts"
import { testConfig } from "./helpers/db.ts"

describe("renderLlms", () => {
  test("collapses whitespace and a newline, and escapes brackets", () => {
    const md = renderLlms(
      "links.test",
      [
        {
          name: "Q3  report\n[final]",
          url: "https://links.test/q3",
          destination: "https://x.test/",
        },
      ],
      false,
    )
    expect(md).toContain("[Q3 report \\[final\\]](https://links.test/q3): https://x.test/")
  })

  test("falls back to the slug when name is null", () => {
    const md = renderLlms(
      "links.test",
      [{ name: "abc123", url: "https://links.test/abc123", destination: "https://x.test/" }],
      false,
    )
    expect(md).toContain("[abc123](https://links.test/abc123)")
  })

  test("appends a truncation note only when truncated", () => {
    const entry = { name: "a", url: "https://links.test/a", destination: "https://x.test/" }
    expect(renderLlms("links.test", [entry], true)).toContain("Showing the first")
    expect(renderLlms("links.test", [entry], false)).not.toContain("Showing the first")
  })

  test("renders the heading and an empty section for no entries", () => {
    const md = renderLlms("links.test", [], false)
    expect(md).toContain("# links.test")
    expect(md).toContain("## Links")
  })
})

let h: Harness
let author: { keyId: string; key: string }
let domain: string
const HOST = "llms.test"

beforeAll(async () => {
  h = await createHarness()
  author = await h.actor("author")
  domain = await h.createDomain(HOST, "https://example.com/fallback")
})

const get = (path: string, host = HOST) => h.request(path, { host })

describe("GET /llms.txt", () => {
  test("an unknown host is a 404", async () => {
    const res = await get("/llms.txt", "nobody.test")
    expect(res.status).toBe(404)
  })

  test("no key needed: 200 with a markdown content-type", async () => {
    const res = await get("/llms.txt")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toStartWith("text/markdown")
  })

  test("a listed active link renders with its short URL, not merely the destination", async () => {
    const link = await h.createLink(author.key, domain, {
      slug: "public",
      name: "Public link",
      listed: true,
    })
    const body = await (await get("/llms.txt")).text()
    expect(body).toContain(`[Public link](${link.shortUrl}): ${link.destination}`)
  })

  test("a link created without listed does not appear — the security property", async () => {
    await h.createLink(author.key, domain, { slug: "private", listed: false })
    const body = await (await get("/llms.txt")).text()
    expect(body).not.toContain("/private)")
  })

  test("an archived listed link does not appear", async () => {
    const link = await h.createLink(author.key, domain, { slug: "was-listed", listed: true })
    await h.request(`/api/v1/links/${link.id}`, { key: author.key, method: "DELETE" })
    const body = await (await get("/llms.txt")).text()
    expect(body).not.toContain(link.shortUrl)
  })

  test("an expired listed link does not appear", async () => {
    const link = await h.createLink(author.key, domain, {
      slug: "expired-listed",
      listed: true,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    const body = await (await get("/llms.txt")).text()
    expect(body).not.toContain(link.shortUrl)
  })
})

describe("invalidation", () => {
  test("a new listed link appears on the next request, not after the TTL", async () => {
    const cache = memoryCache(testConfig)
    const cached = await createHarness({ cache })
    const owner = await cached.actor("author")
    const domainId = await cached.createDomain("llms-cache.test")

    const first = await cached.request("/llms.txt", { host: "llms-cache.test" })
    expect(await first.text()).not.toContain("Second link")

    await cached.createLink(owner.key, domainId, {
      slug: "second",
      name: "Second link",
      listed: true,
    })

    const again = await cached.request("/llms.txt", { host: "llms-cache.test" })
    expect(await again.text()).toContain("Second link")
    cache.stop()
  })
})
