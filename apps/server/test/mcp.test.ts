import { beforeAll, describe, expect, test } from "bun:test"
import { createHarness, type Harness } from "./helpers/app.ts"

// One harness for the whole file: every test reads or adds rows, none needs
// a clean database, and each PGlite instance is the expensive part.
let h: Harness
let viewer: string
let editor: string
let admin: string
let domain: string
let other: string

beforeAll(async () => {
  h = await createHarness()
  viewer = (await h.actor("viewer")).key
  editor = (await h.actor("editor")).key
  admin = (await h.actor("admin")).key
  domain = await h.createDomain("mcp.test")
  other = await h.createDomain("other.test")
})

let nextId = 1

/** One JSON-RPC exchange with the stateless endpoint. */
async function rpc(key: string | undefined, method: string, params: Record<string, unknown> = {}) {
  return h.request("/api/mcp", {
    key,
    method: "POST",
    headers: { accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  })
}

async function toolNames(key: string): Promise<string[]> {
  const res = await rpc(key, "tools/list")
  expect(res.status).toBe(200)
  return ((await res.json()).result.tools as { name: string }[]).map((t) => t.name).sort()
}

/** Calls a tool and returns its parsed JSON payload and error flag. */
async function call(key: string, name: string, args: Record<string, unknown> = {}) {
  const res = await rpc(key, "tools/call", { name, arguments: args })
  expect(res.status).toBe(200)
  const body = await res.json()
  if (body.error) return { isError: true, data: body.error }
  const { content, isError = false } = body.result
  // linq's own results are JSON; the SDK's (an unlisted tool) are plain text.
  const text: string = content[0].text
  try {
    return { isError, data: JSON.parse(text) }
  } catch {
    return { isError, data: text }
  }
}

const READS = ["get_domain", "get_link", "get_stats", "list_domains", "list_links", "list_visits"]

describe("authentication", () => {
  test("rejects a request without a key, before any MCP handling", async () => {
    expect((await rpc(undefined, "tools/list")).status).toBe(401)
  })
})

describe("tools/list follows the key's claims", () => {
  test("a viewer sees only the read tools", async () => {
    expect(await toolNames(viewer)).toEqual(READS)
  })

  test("an editor also creates, edits and replaces rules, but cannot archive", async () => {
    expect(await toolNames(editor)).toEqual(
      [...READS, "create_link", "set_link_rules", "update_link"].sort(),
    )
  })

  test("an admin also archives and restores", async () => {
    expect(await toolNames(admin)).toEqual(
      [...READS, "archive_link", "create_link", "restore_link", "set_link_rules", "update_link"].sort(),
    )
  })
})

describe("tool calls", () => {
  test("each tool reaches its service and returns the REST shape", async () => {
    const created = await call(editor, "create_link", {
      domain_id: domain,
      slug: "via-mcp",
      destination: "https://example.com/a",
    })
    expect(created.isError).toBe(false)
    expect(created.data.short_url).toBe("https://mcp.test/via-mcp")
    const linkId = created.data.id

    expect((await call(viewer, "get_link", { id: linkId })).data.slug).toBe("via-mcp")

    const updated = await call(editor, "update_link", { id: linkId, destination: "https://example.com/b" })
    expect(updated.data.destination).toBe("https://example.com/b")

    const rules = await call(editor, "set_link_rules", {
      id: linkId,
      rules: [{ destination: "https://example.com/ios", conditions: [{ type: "platform", value: "ios" }] }],
    })
    expect(rules.data).toHaveLength(1)

    expect((await call(admin, "archive_link", { id: linkId })).data.status).toBe("archived")
    expect((await call(admin, "restore_link", { id: linkId })).data.status).toBe("active")

    expect((await call(viewer, "list_domains")).data.total).toBe(2)
    expect((await call(viewer, "get_domain", { id: domain })).data.host).toBe("mcp.test")

    await h.recordVisits(linkId, domain, { human: 2, bot: 1 })
    expect((await call(viewer, "get_stats", { link_id: [linkId] })).data).toMatchObject({ human: 2, bot: 1 })
    expect((await call(viewer, "list_visits", { link_id: linkId })).data.total).toBe(3)
  })

  test("array filters are honoured, not dropped by the comma-separated query schema", async () => {
    await h.createLink(editor, other, { slug: "elsewhere" })
    const all = await call(viewer, "list_links", {})
    const onOther = await call(viewer, "list_links", { domain_id: [other] })
    expect(onOther.data.data.map((l: { slug: string }) => l.slug)).toEqual(["elsewhere"])
    expect(all.data.total).toBeGreaterThan(onOther.data.total)
  })
})

describe("errors", () => {
  test("a viewer cannot call a write tool, and nothing is written", async () => {
    const res = await call(viewer, "create_link", {
      domain_id: domain,
      slug: "not-allowed",
      destination: "https://example.com/",
    })
    expect(res.isError).toBe(true)
    // Not registered for this key at all, so the SDK refuses it by name.
    expect(String(res.data)).toContain("create_link")
    const rows = await h.db.selectFrom("links").select("id").where("slug", "=", "not-allowed").execute()
    expect(rows).toHaveLength(0)
  })

  test("an ApiError comes back as the REST error envelope", async () => {
    const res = await call(viewer, "get_link", { id: Bun.randomUUIDv7() })
    expect(res.isError).toBe(true)
    expect(res.data.error.code).toBe("not_found")
  })

  test("REST's own validation still applies after the tool's", async () => {
    const res = await call(viewer, "get_stats", { from: "2026-02-01", to: "2026-01-01" })
    expect(res.isError).toBe(true)
    expect(res.data.error.code).toBe("validation_failed")
  })
})
