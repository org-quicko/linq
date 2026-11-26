import { beforeAll, describe, expect, setSystemTime, test } from "bun:test"
import type { Link, LinkTree } from "@linq/shared"
import { MemoryCacheAdapter } from "../src/adapters/index.ts"
import { createHarness, type Harness } from "./helpers/app.ts"
import { testConfig } from "./helpers/db.ts"

const HOST = "trees.test"
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120"

let h: Harness
let admin: { keyId: string; key: string }
let editor: { keyId: string; key: string }
let viewer: { keyId: string; key: string }
let domain: string
let otherDomain: string

beforeAll(async () => {
  // A real cache, so the tests also prove every write clears what it should.
  h = await createHarness({ cache: new MemoryCacheAdapter(testConfig) })
  admin = await h.actor("admin")
  editor = await h.actor("editor")
  viewer = await h.actor("viewer")
  domain = await h.createDomain(HOST)
  otherDomain = await h.createDomain("elsewhere.test")
})

async function createTree(body: Record<string, unknown> = {}): Promise<LinkTree> {
  const res = await h.post("/api/v1/link-trees", editor.key, {
    domain_id: domain,
    name: "Ada Lovelace",
    ...body,
  })
  if (res.status !== 201) throw new Error(`createTree failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as LinkTree
}

const page = (slug: string, init: RequestInit = {}) =>
  h.request(`/${slug}`, { host: HOST, headers: { "user-agent": DESKTOP }, ...init })

async function lastVisit() {
  await h.flushVisits()
  return await h.db.selectFrom("visits").selectAll().orderBy("id", "desc").executeTakeFirstOrThrow()
}

describe("POST /api/v1/link-trees", () => {
  test("a viewer may not create one", async () => {
    const res = await h.post("/api/v1/link-trees", viewer.key, { domain_id: domain, name: "x" })
    expect(res.status).toBe(403)
  })

  test("creates a tree with defaults and no Items", async () => {
    const tree = await createTree({ slug: "ada" })
    expect(tree).toMatchObject({
      slug: "ada",
      type: "tree",
      destination: null,
      name: "Ada Lovelace",
      short_url: `https://${HOST}/ada`,
      item_count: 0,
      tree: { image_url: null, appearance: "auto", accent: "#171717", button_style: "filled" },
    })
    expect(tree.tree.items).toEqual([])
  })

  test("an existing Link becomes an Item labelled with its name unless one is given", async () => {
    const blog = await h.createLink(editor.key, domain, { name: "Blog" })
    const docs = await h.createLink(editor.key, domain, { name: "Docs" })
    const tree = await createTree({
      items: [{ link_id: blog.id }, { link_id: docs.id, label: "Read the docs" }],
    })
    expect(tree.item_count).toBe(2)
    expect(tree.tree.items.map((item) => [item.label, item.link.id])).toEqual([
      ["Blog", blog.id],
      ["Read the docs", docs.id],
    ])
  })

  test("a URL Item becomes a new short Link that lists with the other Short links", async () => {
    const tree = await createTree({
      items: [{ url: "https://example.com/talk", label: "My talk" }],
    })
    const [item] = tree.tree.items
    expect(item.label).toBe("My talk")
    expect(item.link.destination).toBe("https://example.com/talk")
    // The Item's title names the new short Link too.
    expect(item.link.name).toBe("My talk")

    const links = await h.request(`/api/v1/links?domain_id=${domain}&limit=200`, {
      key: editor.key,
    })
    const ids = ((await links.json()).data as Link[]).map((link) => link.id)
    expect(ids).toContain(item.link.id)
    expect(ids).not.toContain(tree.id)
  })

  test("refuses Items on another Domain, archived, missing, or themselves trees", async () => {
    const foreign = await h.createLink(editor.key, otherDomain)
    const archived = await h.createLink(editor.key, domain)
    await h.request(`/api/v1/links/${archived.id}`, { key: admin.key, method: "DELETE" })
    const nested = await createTree()

    const res = await h.post("/api/v1/link-trees", editor.key, {
      domain_id: domain,
      name: "Bad",
      items: [
        { link_id: foreign.id },
        { link_id: archived.id },
        { link_id: crypto.randomUUID() },
        { link_id: nested.id },
      ],
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    const messages = body.error.details.map((d: { path: unknown[]; message: string }) => [
      d.path.join("."),
      d.message,
    ])
    expect(messages).toEqual([
      ["items.0.link_id", "must be a link on the tree's domain"],
      ["items.1.link_id", "link is archived"],
      ["items.2.link_id", "link not found"],
      ["items.3.link_id", "a link tree cannot list another link tree"],
    ])
  })

  test("a failed save creates none of its URL Items' Links", async () => {
    await createTree({ slug: "taken" })
    const before = await h.db.selectFrom("links").select("id").execute()
    const res = await h.post("/api/v1/link-trees", editor.key, {
      domain_id: domain,
      name: "Dup",
      slug: "taken",
      items: [{ url: "https://example.com/orphan" }],
    })
    expect(res.status).toBe(409)
    expect(await h.db.selectFrom("links").select("id").execute()).toHaveLength(before.length)
  })

  test("rejects a reserved slug, a bad accent, and an Item with both link_id and url", async () => {
    const reserved = await h.post("/api/v1/link-trees", editor.key, {
      domain_id: domain,
      name: "x",
      slug: "api",
    })
    expect(reserved.status).toBe(400)
    const accent = await h.post("/api/v1/link-trees", editor.key, {
      domain_id: domain,
      name: "x",
      accent: "blue",
    })
    expect(accent.status).toBe(400)
    const both = await h.post("/api/v1/link-trees", editor.key, {
      domain_id: domain,
      name: "x",
      items: [{ link_id: crypto.randomUUID(), url: "https://example.com/" }],
    })
    expect(both.status).toBe(400)
  })
})

describe("listing, reading and counting", () => {
  test("GET /links lists trees only when asked", async () => {
    const tree = await createTree()
    const trees = await h.request(`/api/v1/links?type=tree&limit=200`, { key: viewer.key })
    expect(((await trees.json()).data as Link[]).map((l) => l.id)).toContain(tree.id)
    const all = await h.request(`/api/v1/links?type=all&limit=200`, { key: viewer.key })
    expect(((await all.json()).data as Link[]).some((l) => l.type === "redirect")).toBe(true)
  })

  test("GET /links/count counts each type separately", async () => {
    const count = async (query: string) =>
      (await (await h.request(`/api/v1/links/count?${query}`, { key: viewer.key })).json()).total
    const [redirects, trees, all] = await Promise.all([
      count(""),
      count("type=tree"),
      count("type=all"),
    ])
    expect(trees).toBeGreaterThan(0)
    expect(redirects + trees).toBe(all)
  })

  test("GET /link-trees/:id is a 404 for a redirect Link", async () => {
    const link = await h.createLink(editor.key, domain)
    const res = await h.request(`/api/v1/link-trees/${link.id}`, { key: viewer.key })
    expect(res.status).toBe(404)
  })
})

describe("PATCH /api/v1/link-trees/:id", () => {
  test("updates the page and replaces the Items in the order sent", async () => {
    const a = await h.createLink(editor.key, domain, { name: "A" })
    const b = await h.createLink(editor.key, domain, { name: "B" })
    const tree = await createTree({ items: [{ link_id: a.id }, { link_id: b.id }] })

    const res = await h.patch(`/api/v1/link-trees/${tree.id}`, editor.key, {
      name: "Ada",
      description: "Mathematician",
      accent: "#2563EB",
      button_style: "soft",
      appearance: "dark",
      items: [{ link_id: b.id }, { link_id: a.id, label: "First" }],
    })
    expect(res.status).toBe(200)
    const updated = (await res.json()) as LinkTree
    expect(updated).toMatchObject({ name: "Ada", description: "Mathematician" })
    expect(updated.tree).toMatchObject({
      accent: "#2563eb",
      button_style: "soft",
      appearance: "dark",
    })
    expect(updated.tree.items.map((item) => item.label)).toEqual(["B", "First"])
  })

  test("a viewer may not edit, and a redirect Link is not a tree", async () => {
    const tree = await createTree()
    expect((await h.patch(`/api/v1/link-trees/${tree.id}`, viewer.key, { name: "x" })).status).toBe(
      403,
    )
    const link = await h.createLink(editor.key, domain)
    expect((await h.patch(`/api/v1/link-trees/${link.id}`, editor.key, { name: "x" })).status).toBe(
      404,
    )
  })

  test("a tree refuses redirect settings and rules through /links", async () => {
    const tree = await createTree()
    const patch = await h.patch(`/api/v1/links/${tree.id}`, editor.key, {
      destination: "https://example.com/",
    })
    expect(patch.status).toBe(400)
    const rules = await h.request(`/api/v1/links/${tree.id}/rules`, {
      key: editor.key,
      method: "PUT",
      body: JSON.stringify([]),
    })
    expect(rules.status).toBe(409)
    // Tags and archiving still go through /links like any other Link.
    expect((await h.patch(`/api/v1/links/${tree.id}`, editor.key, { tags: ["bio"] })).status).toBe(
      200,
    )
  })
})

describe("the public page", () => {
  test("serves the page with its Items, records the view, and leaves HEAD untracked", async () => {
    const blog = await h.createLink(editor.key, domain, { slug: "blog", name: "Blog" })
    const tree = await createTree({
      slug: "me",
      description: "Hello",
      items: [{ link_id: blog.id, label: "My blog" }],
    })

    const res = await page("me")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'")
    const html = await res.text()
    expect(html).toContain("<h1>Ada Lovelace</h1>")
    expect(html).toContain('<a class="item" href="/blog">My blog</a>')
    expect(html).toContain(`<meta property="og:url" content="https://${HOST}/me">`)

    const visit = await lastVisit()
    expect(visit).toMatchObject({ link_id: tree.id, destination: null, slug_requested: "me" })

    await h.flushVisits()
    const before = (await h.db.selectFrom("visits").select("id").execute()).length
    expect((await page("me", { method: "HEAD" })).status).toBe(200)
    await h.flushVisits()
    expect(await h.db.selectFrom("visits").select("id").execute()).toHaveLength(before)
  })

  test("escapes every user-supplied string", async () => {
    const link = await h.createLink(editor.key, domain)
    await createTree({
      slug: "xss",
      name: `<script>alert(1)</script>`,
      items: [{ link_id: link.id, label: `"><img src=x onerror=alert(1)>` }],
    })
    const html = await (await page("xss")).text()
    expect(html).not.toContain("<script>alert")
    expect(html).not.toContain("<img src=x")
    expect(html).toContain("&lt;script&gt;")
  })

  test("drops Items whose Link is archived or expired, even after the page was cached", async () => {
    const live = await h.createLink(editor.key, domain, { slug: "live" })
    const doomed = await h.createLink(editor.key, domain, { slug: "doomed" })
    const lapsing = await h.createLink(editor.key, domain, {
      slug: "lapsing",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    })
    await createTree({
      slug: "filtered",
      items: [
        { link_id: live.id, label: "Live" },
        { link_id: doomed.id, label: "Doomed" },
        { link_id: lapsing.id, label: "Lapsing" },
      ],
    })
    expect(await (await page("filtered")).text()).toContain(">Doomed<")

    // Archiving an Item's Link must clear the tree's cached page too.
    await h.request(`/api/v1/links/${doomed.id}`, { key: admin.key, method: "DELETE" })
    const afterArchive = await (await page("filtered")).text()
    expect(afterArchive).toContain(">Live<")
    expect(afterArchive).not.toContain(">Doomed<")

    expect(afterArchive).toContain(">Lapsing<")

    // Expiry is checked at render time: the cached entry outlives the moment
    // the Item lapses, and no mutation arrives to clear it. Two minutes on is
    // past the expiry but well inside the cache TTL.
    setSystemTime(new Date(Date.now() + 120_000))
    try {
      expect(await (await page("filtered")).text()).not.toContain(">Lapsing<")
    } finally {
      setSystemTime()
    }
  })

  test("editing an Item's Link and editing the tree both refresh the cached page", async () => {
    const link = await h.createLink(editor.key, domain, { name: "Before" })
    const tree = await createTree({ slug: "fresh", items: [{ link_id: link.id }] })
    expect(await (await page("fresh")).text()).toContain(">Before<")

    await h.patch(`/api/v1/link-trees/${tree.id}`, editor.key, { name: "Renamed tree" })
    expect(await (await page("fresh")).text()).toContain("<h1>Renamed tree</h1>")

    await h.patch(`/api/v1/links/${link.id}`, editor.key, { expires_at: "2000-01-01T00:00:00Z" })
    expect(await (await page("fresh")).text()).not.toContain(">Before<")
  })

  test("purging an Item's Link removes the Item", async () => {
    const link = await h.createLink(editor.key, domain)
    const tree = await createTree({ items: [{ link_id: link.id }] })
    await h.request(`/api/v1/links/${link.id}`, { key: admin.key, method: "DELETE" })
    await h.request(`/api/v1/links/${link.id}/purge`, { key: admin.key, method: "DELETE" })
    const res = await h.request(`/api/v1/link-trees/${tree.id}`, { key: viewer.key })
    expect(((await res.json()) as LinkTree).tree.items).toEqual([])
  })

  test("an archived tree is an orphan visit like any archived Link", async () => {
    const tree = await createTree({ slug: "gone" })
    await h.request(`/api/v1/links/${tree.id}`, { key: admin.key, method: "DELETE" })
    expect((await page("gone")).status).toBe(404)
  })
})
