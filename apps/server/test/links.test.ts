import { beforeAll, describe, expect, test } from "bun:test"
import { inArray } from "drizzle-orm"
import { links } from "../src/db/schema.ts"
import {
  httpMetadataFetcher,
  type MetadataFetcher,
  noMetadata,
  startMetadata,
} from "../src/link-metadata.ts"
import { createHarness, type Harness } from "./helpers/app.ts"
import { testConfig } from "./helpers/db.ts"

let h: Harness
let admin: { keyId: string; key: string }
let editor: { keyId: string; key: string }
let domain: string

beforeAll(async () => {
  h = await createHarness()
  admin = await h.actor("admin")
  editor = await h.actor("editor")
  domain = await h.createDomain("links.test")
})

describe("POST /api/v1/links", () => {
  test("a viewer may not create one", async () => {
    const viewer = await h.actor("viewer")
    const res = await h.post("/api/v1/links", viewer.key, {
      domain_id: domain,
      destination: "https://example.com/",
    })
    expect(res.status).toBe(403)
  })

  test("generates a slug of the configured length", async () => {
    const link = await h.createLink(editor.key, domain, { destination: "https://example.com/a" })
    expect(link.slug).toHaveLength(6)
    expect(link.slug).toMatch(/^[A-Za-z0-9]{6}$/)
    expect(link.short_url).toBe(`https://links.test/${link.slug}`)
    expect(link).toMatchObject({
      status: "active",
      forward_query: true,
      preset_params: {},
      human_visits: 0,
      bot_visits: 0,
    })
  })

  test("accepts a custom slug", async () => {
    const link = await h.createLink(editor.key, domain, { slug: "launch" })
    expect(link.slug).toBe("launch")
  })

  test("refuses a slug already taken on the domain, archived ones included", async () => {
    const taken = await h.post("/api/v1/links", editor.key, {
      domain_id: domain,
      destination: "https://example.com/",
      slug: "launch",
    })
    expect(taken.status).toBe(409)

    // ADR 0002: archiving never releases a slug.
    const doomed = await h.createLink(editor.key, domain, { slug: "doomed" })
    await h.request(`/api/v1/links/${doomed.id}`, { key: admin.key, method: "DELETE" })
    const reuse = await h.post("/api/v1/links", editor.key, {
      domain_id: domain,
      destination: "https://example.com/",
      slug: "doomed",
    })
    expect(reuse.status).toBe(409)
  })

  test("the same slug is free on a different domain", async () => {
    const other = await h.createDomain("other.test")
    const link = await h.createLink(editor.key, other, { slug: "launch" })
    expect(link.slug).toBe("launch")
  })

  test("rejects reserved slugs", async () => {
    for (const slug of ["api", "home", "health", "robots.txt", "favicon.ico", "HOME"]) {
      const res = await h.post("/api/v1/links", editor.key, {
        domain_id: domain,
        destination: "https://example.com/",
        slug,
      })
      expect(res.status).toBe(400)
    }
  })

  test("rejects the configured Client UI first segment", async () => {
    const custom = await createHarness({ config: { LINQ_CLIENT_BASE_PATH: "/admin/example" } })
    const customEditor = await custom.actor("editor")
    const customDomain = await custom.createDomain("custom-client-path.test")
    const res = await custom.post("/api/v1/links", customEditor.key, {
      domain_id: customDomain,
      destination: "https://example.com/",
      slug: "admin",
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: {
        code: "validation_failed",
        details: [{ path: ["slug"], message: "slug is reserved" }],
      },
    })
  })

  test("rejects a malformed slug and a non-http destination", async () => {
    const badSlug = await h.post("/api/v1/links", editor.key, {
      domain_id: domain,
      destination: "https://example.com/",
      slug: "has spaces/and-slash",
    })
    expect(badSlug.status).toBe(400)

    const badDestination = await h.post("/api/v1/links", editor.key, {
      domain_id: domain,
      destination: "javascript:alert(1)",
    })
    expect(badDestination.status).toBe(400)
  })

  test("an unknown domain is a 404", async () => {
    const res = await h.post("/api/v1/links", editor.key, {
      domain_id: "00000000-0000-7000-8000-000000000000",
      destination: "https://example.com/",
    })
    expect(res.status).toBe(404)
  })

  test("lowercases tags", async () => {
    const link = await h.createLink(editor.key, domain, { tags: ["Launch", "Q3"] })
    expect(link.tags).toEqual(["launch", "q3"])
  })
})

describe("PATCH /api/v1/links/:id", () => {
  test("slug and domain_id are immutable and rejected outright", async () => {
    const link = await h.createLink(editor.key, domain)
    const other = await h.createDomain("immutable.test")

    expect((await h.patch(`/api/v1/links/${link.id}`, editor.key, { slug: "nope" })).status).toBe(
      400,
    )
    expect(
      (await h.patch(`/api/v1/links/${link.id}`, editor.key, { domain_id: other })).status,
    ).toBe(400)

    const unchanged = await (
      await h.request(`/api/v1/links/${link.id}`, { key: editor.key })
    ).json()
    expect(unchanged.slug).toBe(link.slug)
    expect(unchanged.domain_id).toBe(domain)
  })

  test("any editor edits any link — links have no owner (docs/adr/0016)", async () => {
    const link = await h.createLink(editor.key, domain)
    const otherEditor = await h.actor("editor")

    const res = await h.patch(`/api/v1/links/${link.id}`, otherEditor.key, {
      destination: "https://example.com/moved",
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ destination: "https://example.com/moved" })
  })

  test("a viewer edits nothing", async () => {
    const viewer = await h.actor("viewer")
    const link = await h.createLink(editor.key, domain)
    expect((await h.patch(`/api/v1/links/${link.id}`, viewer.key, { name: "No" })).status).toBe(403)
  })
})

describe("preset params", () => {
  test("a PATCH sets presets and a later PATCH clears them with {}", async () => {
    const link = await h.createLink(editor.key, domain)

    const set = await h.patch(`/api/v1/links/${link.id}`, editor.key, {
      preset_params: { utm_source: "qr" },
    })
    expect(set.status).toBe(200)
    expect(await set.json()).toMatchObject({ preset_params: { utm_source: "qr" } })

    const cleared = await h.patch(`/api/v1/links/${link.id}`, editor.key, { preset_params: {} })
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toMatchObject({ preset_params: {} })
  })

  test("rejects an empty key", async () => {
    const res = await h.post("/api/v1/links", editor.key, {
      domain_id: domain,
      destination: "https://example.com/",
      preset_params: { "": "value" },
    })
    expect(res.status).toBe(400)
  })

  test("rejects an over-long value", async () => {
    const res = await h.post("/api/v1/links", editor.key, {
      domain_id: domain,
      destination: "https://example.com/",
      preset_params: { a: "x".repeat(513) },
    })
    expect(res.status).toBe(400)
  })

  test("rejects more than 20 keys", async () => {
    const preset_params = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"]))
    const res = await h.post("/api/v1/links", editor.key, {
      domain_id: domain,
      destination: "https://example.com/",
      preset_params,
    })
    expect(res.status).toBe(400)
  })
})

describe("archive and restore permissions", () => {
  test("an editor may not archive or restore, only an admin", async () => {
    const link = await h.createLink(editor.key, domain)

    const archiveDenied = await h.request(`/api/v1/links/${link.id}`, {
      key: editor.key,
      method: "DELETE",
    })
    expect(archiveDenied.status).toBe(403)

    const statusPatchDenied = await h.patch(`/api/v1/links/${link.id}`, editor.key, {
      status: "archived",
    })
    expect(statusPatchDenied.status).toBe(403)

    const archived = await h.request(`/api/v1/links/${link.id}`, {
      key: admin.key,
      method: "DELETE",
    })
    expect(archived.status).toBe(200)

    const restoreDenied = await h.patch(`/api/v1/links/${link.id}`, editor.key, {
      status: "active",
    })
    expect(restoreDenied.status).toBe(403)
  })
})

describe("link expiry", () => {
  test("POST echoes expires_at as ISO, and PATCH round-trips it", async () => {
    const iso = new Date(Date.now() + 3600_000).toISOString()
    const link = await h.createLink(editor.key, domain, { expires_at: iso })
    expect(link.expires_at).toBe(iso)

    const later = new Date(Date.now() + 7200_000).toISOString()
    const updated = await h.patch(`/api/v1/links/${link.id}`, editor.key, { expires_at: later })
    expect((await updated.json()).expires_at).toBe(later)

    const cleared = await h.patch(`/api/v1/links/${link.id}`, editor.key, { expires_at: null })
    expect((await cleared.json()).expires_at).toBeNull()
  })

  test("defaults to never expiring", async () => {
    const link = await h.createLink(editor.key, domain)
    expect(link.expires_at).toBeNull()
  })

  test("?expiry partitions the list; the default list includes an expired link", async () => {
    const scoped = await h.createDomain("expiry-filter.test")
    const live = await h.createLink(editor.key, scoped, {
      slug: "still-live",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    })
    const dead = await h.createLink(editor.key, scoped, {
      slug: "long-dead",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    })
    const forever = await h.createLink(editor.key, scoped, { slug: "forever" })

    const list = async (query = "") =>
      (
        await (
          await h.request(`/api/v1/links?domain_id=${scoped}${query}`, { key: editor.key })
        ).json()
      ).data.map((l: { id: string }) => l.id) as string[]

    expect((await list()).sort()).toEqual([live.id, dead.id, forever.id].sort())
    expect(await list("&expiry=expired")).toEqual([dead.id])
    expect((await list("&expiry=live")).sort()).toEqual([live.id, forever.id].sort())
  })
})

describe("archiving a link", () => {
  test("DELETE archives, and archived can go back to active", async () => {
    const link = await h.createLink(editor.key, domain)

    const archived = await h.request(`/api/v1/links/${link.id}`, {
      key: admin.key,
      method: "DELETE",
    })
    expect(archived.status).toBe(200)
    expect(await archived.json()).toMatchObject({ status: "archived" })

    const back = await h.patch(`/api/v1/links/${link.id}`, admin.key, { status: "active" })
    expect(await back.json()).toMatchObject({ status: "active" })
  })
})

describe("GET /api/v1/links", () => {
  test("hides archived links unless asked", async () => {
    const scoped = await h.createDomain("filters.test")
    const live = await h.createLink(editor.key, scoped, { slug: "live" })
    const dead = await h.createLink(editor.key, scoped, { slug: "dead" })
    await h.request(`/api/v1/links/${dead.id}`, { key: admin.key, method: "DELETE" })

    const list = async (query: string) =>
      (
        await (
          await h.request(`/api/v1/links?domain_id=${scoped}${query}`, { key: editor.key })
        ).json()
      ).data as { id: string }[]

    expect((await list("")).map((l) => l.id)).toEqual([live.id])
    expect((await list("&status=archived")).map((l) => l.id)).toEqual([dead.id])
    expect((await list("&status=all")).map((l) => l.id).sort()).toEqual([live.id, dead.id].sort())
  })

  test("filters by tag and search term", async () => {
    const scoped = await h.createDomain("search.test")
    const tagged = await h.createLink(editor.key, scoped, {
      slug: "quarterly",
      tags: ["report"],
      name: "Quarterly report",
    })
    await h.createLink(editor.key, scoped, { slug: "misc", tags: ["other"] })

    const list = async (query: string) =>
      (
        await (
          await h.request(`/api/v1/links?domain_id=${scoped}&${query}`, { key: editor.key })
        ).json()
      ).data as { id: string }[]

    expect((await list("tags=report")).map((l) => l.id)).toEqual([tagged.id])
    expect((await list("search=quarter")).map((l) => l.id)).toEqual([tagged.id])
    expect((await list("search=QUARTERLY+REPORT")).map((l) => l.id)).toEqual([tagged.id])
    expect(await list("tags=nothing")).toHaveLength(0)
  })

  test("paginates and reports the matching total, not the page size", async () => {
    const scoped = await h.createDomain("paged.test")
    for (let i = 0; i < 3; i++) await h.createLink(editor.key, scoped, { slug: `p${i}` })

    const res = await h.request(`/api/v1/links?domain_id=${scoped}&limit=2`, { key: editor.key })
    const body = await res.json()
    expect(body.data).toHaveLength(2)
    expect(body).toMatchObject({ total: 3, limit: 2, offset: 0 })
  })

  test("rejects a limit above the cap", async () => {
    const res = await h.request("/api/v1/links?limit=500", { key: editor.key })
    expect(res.status).toBe(400)
  })

  test("sorts by visit count", async () => {
    const scoped = await h.createDomain("sorted.test")
    const cold = await h.createLink(editor.key, scoped, { slug: "cold" })
    const hot = await h.createLink(editor.key, scoped, { slug: "hot" })
    await h.recordVisits(hot.id, scoped, { human: 2, bot: 1 })
    await h.recordVisits(cold.id, scoped, { human: 1, bot: 0 })

    const res = await h.request(`/api/v1/links?domain_id=${scoped}&sort=visits`, {
      key: editor.key,
    })
    const body = await res.json()
    expect(body.data.map((l: { id: string }) => l.id)).toEqual([hot.id, cold.id])
    expect(body.data[0]).toMatchObject({ human_visits: 2, bot_visits: 1 })
  })

  test("sorts by updated_at, leading with the link PATCHed last", async () => {
    const scoped = await h.createDomain("updated.test")
    const first = await h.createLink(editor.key, scoped, { slug: "first" })
    const second = await h.createLink(editor.key, scoped, { slug: "second" })
    await h.patch(`/api/v1/links/${first.id}`, editor.key, { name: "touched last" })

    const res = await h.request(`/api/v1/links?domain_id=${scoped}&sort=updated_at&order=desc`, {
      key: editor.key,
    })
    const body = await res.json()
    expect(body.data.map((l: { id: string }) => l.id)).toEqual([first.id, second.id])
  })

  test("order=asc is the exact reverse of order=desc", async () => {
    const scoped = await h.createDomain("order.test")
    for (let i = 0; i < 3; i++) await h.createLink(editor.key, scoped, { slug: `o${i}` })

    const desc = await (
      await h.request(`/api/v1/links?domain_id=${scoped}&sort=created_at&order=desc`, {
        key: editor.key,
      })
    ).json()
    const asc = await (
      await h.request(`/api/v1/links?domain_id=${scoped}&sort=created_at&order=asc`, {
        key: editor.key,
      })
    ).json()
    expect(asc.data.map((l: { id: string }) => l.id)).toEqual(
      [...desc.data.map((l: { id: string }) => l.id)].reverse(),
    )
  })

  test("rejects an unknown sort value", async () => {
    const res = await h.request("/api/v1/links?sort=bogus", { key: editor.key })
    expect(res.status).toBe(400)
  })

  test("tiebreaks equal sort keys by id, so paging is deterministic", async () => {
    const scoped = await h.createDomain("tiebreak.test")
    const now = new Date()
    const rows = await Promise.all(
      ["a", "b", "c"].map((slug) => h.createLink(editor.key, scoped, { slug })),
    )
    await h.db
      .update(links)
      .set({ created_at: now })
      .where(
        inArray(
          links.id,
          rows.map((r) => r.id),
        ),
      )

    const pages = await Promise.all(
      [0, 1, 2].map((offset) =>
        h
          .request(`/api/v1/links?domain_id=${scoped}&limit=1&offset=${offset}`, {
            key: editor.key,
          })
          .then((r) => r.json()),
      ),
    )
    const seen = pages.map((p) => p.data[0].id)
    expect(new Set(seen).size).toBe(3)
    expect(seen.sort()).toEqual(rows.map((r) => r.id).sort())
  })
})

describe("GET /api/v1/links/count", () => {
  test("defaults to active, and moves a link between active and archived", async () => {
    const scoped = await h.createDomain("count.test")
    const live = await h.createLink(editor.key, scoped, { slug: "count-live" })

    // Counted instance-wide, not per domain (the endpoint takes only
    // `status`), so this asserts the delta a fresh archive makes rather than
    // an exact total that would depend on every other describe block's data.
    const total = async (query = "") =>
      (await (await h.request(`/api/v1/links/count${query}`, { key: editor.key })).json())
        .total as number

    const activeBefore = await total()
    const archivedBefore = await total("?status=archived")

    await h.request(`/api/v1/links/${live.id}`, { key: admin.key, method: "DELETE" })

    expect(await total()).toBe(activeBefore - 1)
    expect(await total("?status=archived")).toBe(archivedBefore + 1)
  })
})

describe("GET /api/v1/tags", () => {
  // Tags are counted across the whole instance, so this needs a database of its own.
  test("counts tags over active links, most used first", async () => {
    const fresh = await createHarness()
    const owner = await fresh.actor("editor")
    const admin = await fresh.actor("admin")
    const scoped = await fresh.createDomain("tags.test")

    await fresh.createLink(owner.key, scoped, { slug: "t1", tags: ["shared", "solo"] })
    await fresh.createLink(owner.key, scoped, { slug: "t2", tags: ["shared"] })
    const archived = await fresh.createLink(owner.key, scoped, { slug: "t3", tags: ["gone"] })
    await fresh.request(`/api/v1/links/${archived.id}`, { key: admin.key, method: "DELETE" })

    const tags = await (await fresh.request("/api/v1/tags", { key: owner.key })).json()
    expect(tags).toEqual([
      { tag: "shared", count: 2 },
      { tag: "solo", count: 1 },
    ])
  })
})

describe("link preview metadata", () => {
  let hMeta: Harness
  let metaAuthor: { keyId: string; key: string }
  let metaDomain: string

  const fakeMetadata: MetadataFetcher = {
    fetch: async (destination) =>
      destination.includes("blocked")
        ? { name: null, description: null, icon_url: null }
        : {
            name: "Fetched title",
            description: "Fetched description",
            icon_url: "https://cdn.example/icon.png",
          },
  }

  beforeAll(async () => {
    hMeta = await createHarness({ metadata: fakeMetadata })
    metaAuthor = await hMeta.actor("editor")
    metaDomain = await hMeta.createDomain("metadata.test")
  })

  test("create, nothing supplied fills name, description, icon_url from fetch", async () => {
    const link = await hMeta.createLink(metaAuthor.key, metaDomain, {
      destination: "https://example.com/page",
    })
    expect(link.name).toBe("Fetched title")
    expect(link.description).toBe("Fetched description")
    expect(link.icon_url).toBe("https://cdn.example/icon.png")
  })

  test("create, name supplied, description omitted keeps name and fills description and icon_url", async () => {
    const link = await hMeta.createLink(metaAuthor.key, metaDomain, {
      destination: "https://example.com/custom-name",
      name: "Custom title",
    })
    expect(link.name).toBe("Custom title")
    expect(link.description).toBe("Fetched description")
    expect(link.icon_url).toBe("https://cdn.example/icon.png")
  })

  test("create against a destination whose fetch finds nothing succeeds with null fields", async () => {
    const link = await hMeta.createLink(metaAuthor.key, metaDomain, {
      destination: "https://example.com/blocked",
    })
    expect(link.name).toBeNull()
    expect(link.description).toBeNull()
    expect(link.icon_url).toBeNull()
  })

  test("patch changing destination refreshes name, description, icon_url", async () => {
    const link = await hMeta.createLink(metaAuthor.key, metaDomain, {
      destination: "https://example.com/blocked",
    })
    expect(link.name).toBeNull()
    expect(link.description).toBeNull()
    expect(link.icon_url).toBeNull()

    const res = await hMeta.patch(`/api/v1/links/${link.id}`, metaAuthor.key, {
      destination: "https://example.com/new-dest",
    })
    expect(res.status).toBe(200)
    const updated = await res.json()
    expect(updated.name).toBe("Fetched title")
    expect(updated.description).toBe("Fetched description")
    expect(updated.icon_url).toBe("https://cdn.example/icon.png")
  })

  test("patch changing destination and explicitly clearing name keeps name null", async () => {
    const link = await hMeta.createLink(metaAuthor.key, metaDomain, {
      destination: "https://example.com/initial",
    })
    expect(link.name).toBe("Fetched title")

    const res = await hMeta.patch(`/api/v1/links/${link.id}`, metaAuthor.key, {
      destination: "https://example.com/other",
      name: null,
    })
    expect(res.status).toBe(200)
    const updated = await res.json()
    expect(updated.name).toBeNull()
    expect(updated.description).toBe("Fetched description")
    expect(updated.icon_url).toBe("https://cdn.example/icon.png")
  })

  test("patch changing destination where fetch finds nothing keeps old name, description, icon_url", async () => {
    const link = await hMeta.createLink(metaAuthor.key, metaDomain, {
      destination: "https://example.com/initial",
    })
    expect(link.name).toBe("Fetched title")
    expect(link.description).toBe("Fetched description")
    expect(link.icon_url).toBe("https://cdn.example/icon.png")

    const res = await hMeta.patch(`/api/v1/links/${link.id}`, metaAuthor.key, {
      destination: "https://example.com/blocked",
    })
    expect(res.status).toBe(200)
    const updated = await res.json()
    expect(updated.name).toBe("Fetched title")
    expect(updated.description).toBe("Fetched description")
    expect(updated.icon_url).toBe("https://cdn.example/icon.png")
  })

  test("patch that does not touch destination never invokes the fetcher", async () => {
    let callCount = 0
    let shouldThrow = false
    const spyMetadata: MetadataFetcher = {
      fetch: async () => {
        callCount++
        if (shouldThrow) throw new Error("fetch should not have been called")
        return {
          name: "Initial title",
          description: "Initial description",
          icon_url: "https://cdn.example/icon.png",
        }
      },
    }
    const hSpy = await createHarness({ metadata: spyMetadata })
    const a = await hSpy.actor("editor")
    const d = await hSpy.createDomain("spy.test")

    const link = await hSpy.createLink(a.key, d, { destination: "https://example.com/initial" })
    expect(callCount).toBe(1)
    expect(link.name).toBe("Initial title")

    shouldThrow = true
    const res = await hSpy.patch(`/api/v1/links/${link.id}`, a.key, { tags: ["untouched"] })
    expect(res.status).toBe(200)
    expect(callCount).toBe(1)
    const updated = await res.json()
    expect(updated.tags).toEqual(["untouched"])
    expect(updated.name).toBe("Initial title")
    expect(updated.description).toBe("Initial description")
    expect(updated.icon_url).toBe("https://cdn.example/icon.png")
  })
})

describe("SSRF guard", () => {
  test("httpMetadataFetcher blocks loopback and cloud metadata", async () => {
    const fetcher = httpMetadataFetcher()
    const meta1 = await fetcher.fetch("http://169.254.169.254/")
    expect(meta1).toEqual({ name: null, description: null, icon_url: null })

    const meta2 = await fetcher.fetch("http://127.0.0.1:1/")
    expect(meta2).toEqual({ name: null, description: null, icon_url: null })
  })
})

describe("startMetadata config", () => {
  test("returns noMetadata when LINQ_FETCH_LINK_METADATA is false", () => {
    const metadata = startMetadata({ ...testConfig, LINQ_FETCH_LINK_METADATA: "false" })
    expect(metadata).toBe(noMetadata)
  })
})
