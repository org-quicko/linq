import {
  type Cache,
  type Caddy,
  claimsForPreset,
  type KeyPreset,
  type Link,
  type MetadataFetcher,
} from "@linq/shared"
import type { Insertable } from "kysely"
import { createApp } from "../../src/app.ts"
import type { Db } from "../../src/clients/index.ts"
import type { DB } from "../../src/db/types.generated.ts"
import { ApiKeyService } from "../../src/services/ApiKeyService.ts"
import { VisitPipeline } from "../../src/telemetry/index.ts"
import { createTestDb, testConfig } from "./db.ts"

/** `json()` is deliberately loose: the assertion in each test does the narrowing. */
// biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted, not typed
export type TestResponse = Omit<Response, "json"> & { json: () => Promise<any> }

export type Harness = {
  db: Db
  /** Waits for every visit the redirect has handed to this app's `VisitPipeline`. */
  flushVisits: () => Promise<void>
  /** Calls the app over `fetch`, no socket involved. */
  request: (
    path: string,
    init?: RequestInit & { key?: string; host?: string },
  ) => Promise<TestResponse>
  post: (path: string, key: string, body: unknown) => Promise<TestResponse>
  patch: (path: string, key: string, body: unknown) => Promise<TestResponse>
  createKey: (opts: { preset: KeyPreset; name?: string; expiresAt?: Date }) => Promise<{
    keyId: string
    key: string
  }>
  /** A key of a named claim preset. The key is the principal. */
  actor: (preset: KeyPreset) => Promise<{ keyId: string; key: string }>
  /** Inserted directly: most suites need a domain without exercising its API. */
  createDomain: (host: string, fallbackUrl?: string) => Promise<string>
  /** Goes through the API, so slug generation and ownership are the real thing. */
  createLink: (key: string, domainId: string, body?: Record<string, unknown>) => Promise<Link>
  /** Visit rows written straight to the table; the redirect handler lands in milestone 4. */
  recordVisits: (
    linkId: string | null,
    domainId: string,
    counts: { human?: number; bot?: number },
    overrides?: Partial<Insertable<DB["visits"]>>,
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
  const visitPipeline = new VisitPipeline(db, config)
  const app = createApp({
    db,
    config,
    visitPipeline,
    cache: options.cache,
    caddy: options.caddy,
    metadata: options.metadata,
  })

  const request: Harness["request"] = async (path, init = {}) => {
    const { key, host = "localhost", ...rest } = init
    const headers = new Headers(rest.headers)
    if (key) headers.set("authorization", `Bearer ${key}`)
    if (rest.body && !headers.has("content-type")) headers.set("content-type", "application/json")
    return await app.fetch(new Request(`http://${host}${path}`, { ...rest, headers }))
  }

  const createKey: Harness["createKey"] = async ({ preset, name = preset, expiresAt }) => {
    const { row, secret } = await new ApiKeyService(db).create({
      name,
      claims: claimsForPreset[preset],
      expiresAt: expiresAt ?? null,
    })
    return { keyId: row.id, key: secret }
  }

  return {
    db,
    flushVisits: () => visitPipeline.flush(),
    request,
    createKey,
    post: (path, key, body) => request(path, { key, method: "POST", body: JSON.stringify(body) }),
    patch: (path, key, body) => request(path, { key, method: "PATCH", body: JSON.stringify(body) }),
    actor: (preset) => createKey({ preset }),
    createDomain: async (host, fallbackUrl) => {
      const id = Bun.randomUUIDv7()
      await db
        .insertInto("domains")
        .values({ id, host, fallback_url: fallbackUrl ?? null })
        .execute()
      return id
    },
    createLink: async (key, domainId, body = {}) => {
      const res = await request("/api/v1/links", {
        key,
        method: "POST",
        body: JSON.stringify({ domain_id: domainId, destination: "https://example.com/", ...body }),
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
        link_id: linkId,
        domain_id: domainId,
        slug_requested: "test",
        is_bot: isBot,
        platform: "desktop" as const,
        ...overrides,
      }))
      if (rows.length) await db.insertInto("visits").values(rows).execute()
    },
  }
}
