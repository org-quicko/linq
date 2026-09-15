import type { Linq, Role } from "@linq/shared"
import { generateKey, hashKey, keyPrefix } from "../../src/auth/keys.ts"
import { type Geo, noGeo } from "../../src/clicks/geo.ts"
import type { Db } from "../../src/db/client.ts"
import { apiKeys, clicks, domains, users } from "../../src/db/schema.ts"
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
  createUser: (opts: {
    role: Role
    name?: string
    status?: "active" | "disabled"
  }) => Promise<string>
  createKey: (userId: string, opts?: { expiresAt?: Date }) => Promise<string>
  /** A user of `role` plus a fresh key for it. */
  actor: (role: Role) => Promise<{ userId: string; key: string }>
  /** Inserted directly: most suites need a domain without exercising its API. */
  createDomain: (host: string, fallbackUrl?: string) => Promise<string>
  /** Goes through the API, so slug generation and ownership are the real thing. */
  createLinq: (key: string, domainId: string, body?: Record<string, unknown>) => Promise<Linq>
  /** Click rows written straight to the table; the redirect handler lands in milestone 4. */
  recordClicks: (
    linqId: string | null,
    domainId: string,
    counts: { human?: number; bot?: number },
    overrides?: Partial<typeof clicks.$inferInsert>,
  ) => Promise<void>
}

export type HarnessOptions = { geo?: Geo; config?: Partial<typeof testConfig> }

/**
 * Builds one isolated app and database, plus the shorthands the suites share.
 * Every harness gets its own PGlite instance, so suites never see each other.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const db = await createTestDb()
  const config = { ...testConfig, ...options.config }
  const app = createApp({ db, config, geo: options.geo ?? noGeo })

  const request: Harness["request"] = async (path, init = {}) => {
    const { key, host = "localhost", ...rest } = init
    const headers = new Headers(rest.headers)
    if (key) headers.set("authorization", `Bearer ${key}`)
    if (rest.body && !headers.has("content-type")) headers.set("content-type", "application/json")
    return await app.fetch(new Request(`http://${host}${path}`, { ...rest, headers }))
  }

  const createUser: Harness["createUser"] = async ({ role, name = role, status = "active" }) => {
    const id = Bun.randomUUIDv7()
    await db.insert(users).values({ id, name, role, status })
    return id
  }

  const createKey: Harness["createKey"] = async (userId, opts = {}) => {
    const secret = generateKey()
    await db.insert(apiKeys).values({
      id: Bun.randomUUIDv7(),
      userId,
      label: "test",
      keyHash: hashKey(secret),
      prefix: keyPrefix(secret),
      expiresAt: opts.expiresAt ?? null,
    })
    return secret
  }

  return {
    db,
    request,
    createUser,
    createKey,
    post: (path, key, body) => request(path, { key, method: "POST", body: JSON.stringify(body) }),
    patch: (path, key, body) => request(path, { key, method: "PATCH", body: JSON.stringify(body) }),
    actor: async (role) => {
      const userId = await createUser({ role })
      return { userId, key: await createKey(userId) }
    },
    createDomain: async (host, fallbackUrl) => {
      const id = Bun.randomUUIDv7()
      await db.insert(domains).values({ id, host, fallbackUrl: fallbackUrl ?? null })
      return id
    },
    createLinq: async (key, domainId, body = {}) => {
      const res = await request("/api/v1/linqs", {
        key,
        method: "POST",
        body: JSON.stringify({ domainId, destination: "https://example.com/", ...body }),
      })
      if (res.status !== 201)
        throw new Error(`createLinq failed: ${res.status} ${await res.text()}`)
      return (await res.json()) as Linq
    },
    recordClicks: async (linqId, domainId, counts, overrides = {}) => {
      const rows = [
        ...Array.from({ length: counts.human ?? 0 }, () => false),
        ...Array.from({ length: counts.bot ?? 0 }, () => true),
      ].map((isBot) => ({
        id: Bun.randomUUIDv7(),
        linqId,
        domainId,
        slugRequested: "test",
        isBot,
        platform: "desktop" as const,
        ...overrides,
      }))
      if (rows.length) await db.insert(clicks).values(rows)
    },
  }
}
