import { claimsForPreset, type KeyPreset, type Link } from "@linq/shared"
import { generateKey, hashKey, keyPrefix } from "../../src/auth/keys.ts"
import { type Cache, noCache } from "../../src/cache.ts"
import { type Caddy, noCaddy } from "../../src/caddy.ts"
import type { Db } from "../../src/db/client.ts"
import { apiKeys, domains, visits } from "../../src/db/schema.ts"
import { createApp } from "../../src/http/app.ts"
import { type MetadataFetcher, noMetadata } from "../../src/link-metadata.ts"
import { createTestDb, testConfig } from "./db.ts"

/** `json()` is deliberately loose: the assertion in each test does the narrowing. */
// biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted, not typed
export type TestResponse = Omit<Response, "json"> & { json: () => Promise<any> }

export type Harness = {
  db: Db
  /** Calls the app over `fetch`, no socket involved. */
  request: (
    path: string,
    init?: RequestInit & { key?: string; host?: string },
  ) => Promise<TestResponse>
  post: (path: string, key: string, body: unknown) => Promise<TestResponse>
  patch: (path: string, key: string, body: unknown) => Promise<TestResponse>
  createKey: (opts: { preset: KeyPreset; name?: string; expires_at?: Date }) => Promise<{
    keyId: string
    key: string
  }>
  /** A key of a named claim preset. The key is the principal. */
  actor: (preset: KeyPreset) => Promise<{ keyId: string; key: string }>
  /** Inserted directly: most suites need a domain without exercising its API. */
  createDomain: (host: string, fallback_url?: string) => Promise<string>
  /** Goes through the API, so slug generation and ownership are the real thing. */
  createLink: (key: string, domain_id: string, body?: Record<string, unknown>) => Promise<Link>
  /** Visit rows written straight to the table; the redirect handler lands in milestone 4. */
  recordVisits: (
    link_id: string | null,
    domain_id: string,
    counts: { human?: number; bot?: number },
    overrides?: Partial<typeof visits.$inferInsert>,
  ) => Promise<void>
}

export type HarnessOptions = {
  cache?: Cache
  caddy?: Caddy
  metadata?: MetadataFetcher
  config?: Partial<typeof testConfig>
}

/**
 * Builds one isolated app and database, plus the shorthands the suites share.
 * Every harness gets its own PGlite instance, so suites never see each other.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const db = await createTestDb()
  const config = { ...testConfig, ...options.config }
  const app = createApp({
    db,
    config,
    cache: options.cache ?? noCache,
    caddy: options.caddy ?? noCaddy,
    metadata: options.metadata ?? noMetadata,
  })

  const request: Harness["request"] = async (path, init = {}) => {
    const { key, host = "localhost", ...rest } = init
    const headers = new Headers(rest.headers)
    if (key) headers.set("authorization", `Bearer ${key}`)
    if (rest.body && !headers.has("content-type")) headers.set("content-type", "application/json")
    return await app.fetch(new Request(`http://${host}${path}`, { ...rest, headers }))
  }

  const createKey: Harness["createKey"] = async ({ preset, name = preset, expires_at }) => {
    const secret = generateKey()
    const keyId = Bun.randomUUIDv7()
    await db.insert(apiKeys).values({
      id: keyId,
      name,
      claims: [...claimsForPreset[preset]],
      key_hash: hashKey(secret),
      prefix: keyPrefix(secret),
      expires_at: expires_at ?? null,
    })
    return { keyId, key: secret }
  }

  return {
    db,
    request,
    createKey,
    post: (path, key, body) => request(path, { key, method: "POST", body: JSON.stringify(body) }),
    patch: (path, key, body) => request(path, { key, method: "PATCH", body: JSON.stringify(body) }),
    actor: (preset) => createKey({ preset }),
    createDomain: async (host, fallback_url) => {
      const id = Bun.randomUUIDv7()
      await db.insert(domains).values({ id, host, fallback_url: fallback_url ?? null })
      return id
    },
    createLink: async (key, domain_id, body = {}) => {
      const res = await request("/api/v1/links", {
        key,
        method: "POST",
        body: JSON.stringify({ domain_id, destination: "https://example.com/", ...body }),
      })
      if (res.status !== 201)
        throw new Error(`createLink failed: ${res.status} ${await res.text()}`)
      return (await res.json()) as Link
    },
    recordVisits: async (link_id, domain_id, counts, overrides = {}) => {
      const rows = [
        ...Array.from({ length: counts.human ?? 0 }, () => false),
        ...Array.from({ length: counts.bot ?? 0 }, () => true),
      ].map((is_bot) => ({
        id: Bun.randomUUIDv7(),
        link_id,
        domain_id,
        slug_requested: "test",
        is_bot,
        platform: "desktop" as const,
        ...overrides,
      }))
      if (rows.length) await db.insert(visits).values(rows)
    },
  }
}
