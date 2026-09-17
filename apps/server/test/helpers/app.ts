import type { Link, Role } from "@linq/shared"
import { generateKey, hashKey, keyPrefix } from "../../src/auth/keys.ts"
import { type Cache, noCache } from "../../src/cache.ts"
import type { Db } from "../../src/db/client.ts"
import { apiKeys, domains, visits } from "../../src/db/schema.ts"
import { createApp } from "../../src/http/app.ts"
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
  createKey: (opts: { role: Role; name?: string; expiresAt?: Date }) => Promise<{
    keyId: string
    key: string
  }>
  /** A key of `role`. The key is the principal, so this is the whole identity. */
  actor: (role: Role) => Promise<{ keyId: string; key: string }>
  /** Inserted directly: most suites need a domain without exercising its API. */
  createDomain: (host: string, fallbackUrl?: string) => Promise<string>
  /** Goes through the API, so slug generation and ownership are the real thing. */
  createLink: (key: string, domainId: string, body?: Record<string, unknown>) => Promise<Link>
  /** Visit rows written straight to the table; the redirect handler lands in milestone 4. */
  recordVisits: (
    linkId: string | null,
    domainId: string,
    counts: { human?: number; bot?: number },
    overrides?: Partial<typeof visits.$inferInsert>,
  ) => Promise<void>
}

export type HarnessOptions = { cache?: Cache; config?: Partial<typeof testConfig> }

/**
 * Builds one isolated app and database, plus the shorthands the suites share.
 * Every harness gets its own PGlite instance, so suites never see each other.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const db = await createTestDb()
  const config = { ...testConfig, ...options.config }
  const app = createApp({ db, config, cache: options.cache ?? noCache })

  const request: Harness["request"] = async (path, init = {}) => {
    const { key, host = "localhost", ...rest } = init
    const headers = new Headers(rest.headers)
    if (key) headers.set("authorization", `Bearer ${key}`)
    if (rest.body && !headers.has("content-type")) headers.set("content-type", "application/json")
    return await app.fetch(new Request(`http://${host}${path}`, { ...rest, headers }))
  }

  const createKey: Harness["createKey"] = async ({ role, name = role, expiresAt }) => {
    const secret = generateKey()
    const keyId = Bun.randomUUIDv7()
    await db.insert(apiKeys).values({
      id: keyId,
      name,
      role,
      keyHash: hashKey(secret),
      prefix: keyPrefix(secret),
      expiresAt: expiresAt ?? null,
    })
    return { keyId, key: secret }
  }

  return {
    db,
    request,
    createKey,
    post: (path, key, body) => request(path, { key, method: "POST", body: JSON.stringify(body) }),
    patch: (path, key, body) => request(path, { key, method: "PATCH", body: JSON.stringify(body) }),
    actor: (role) => createKey({ role }),
    createDomain: async (host, fallbackUrl) => {
      const id = Bun.randomUUIDv7()
      await db.insert(domains).values({ id, host, fallbackUrl: fallbackUrl ?? null })
      return id
    },
    createLink: async (key, domainId, body = {}) => {
      const res = await request("/api/v1/links", {
        key,
        method: "POST",
        body: JSON.stringify({ domainId, destination: "https://example.com/", ...body }),
      })
      if (res.status !== 201)
        throw new Error(`createLink failed: ${res.status} ${await res.text()}`)
      return (await res.json()) as Link
    },
    recordVisits: async (linkId, domainId, counts, overrides = {}) => {
      const rows = [
        ...Array.from({ length: counts.human ?? 0 }, () => false),
        ...Array.from({ length: counts.bot ?? 0 }, () => true),
      ].map((isBot) => ({
        id: Bun.randomUUIDv7(),
        linkId,
        domainId,
        slugRequested: "test",
        isBot,
        platform: "desktop" as const,
        ...overrides,
      }))
      if (rows.length) await db.insert(visits).values(rows)
    },
  }
}
