import { describe, expect, test } from "bun:test"
import type { Caddy } from "@linq/shared"
import { NoopCacheAdapter } from "../src/adapters/index.ts"
import { CaddyClient, GuardedCaddy, NoopCaddyClient } from "../src/clients/index.ts"
import { DomainService } from "../src/services/DomainService.ts"
import { createTestDb, testConfig } from "./helpers/db.ts"

const CADDY_CONFIG = {
  ...testConfig,
  LINQ_CADDY_ADMIN_URL: "http://caddy.test:2019",
  LINQ_CADDY_UPSTREAM: "linq:3000",
}

/** Stands in for Caddy's admin API. Restore the real `fetch` when done. */
function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

describe("CaddyClient.start", () => {
  test("with no admin URL, never calls fetch", async () => {
    const mock = mockFetch(() => new Response(null, { status: 200 }))
    try {
      const caddy = CaddyClient.start(testConfig)
      expect(caddy).toBeInstanceOf(NoopCaddyClient)
      await caddy.upsert("d1", "x.test")
      await caddy.remove("d1")
      expect(mock.calls).toHaveLength(0)
    } finally {
      mock.restore()
    }
  })

  test("upsert deletes then posts a route tagged with the domain's id", async () => {
    const mock = mockFetch(() => new Response(null, { status: 200 }))
    try {
      const caddy = CaddyClient.start(CADDY_CONFIG)
      await caddy.upsert("d1", "example.com:8080")

      expect(mock.calls).toHaveLength(2)
      expect(mock.calls[0].url).toBe("http://caddy.test:2019/id/domain:d1")
      expect(mock.calls[0].init?.method).toBe("DELETE")

      expect(mock.calls[1].url).toBe("http://caddy.test:2019/config/apps/http/servers/srv0/routes")
      expect(mock.calls[1].init?.method).toBe("POST")
      // The host carries a port; Caddy's host matcher only ever sees the hostname.
      expect(JSON.parse(mock.calls[1].init?.body as string)).toEqual({
        "@id": "domain:d1",
        match: [{ host: ["example.com"] }],
        handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "linq:3000" }] }],
      })
    } finally {
      mock.restore()
    }
  })

  test("remove treats a 404 as already-gone, not a failure", async () => {
    const mock = mockFetch(() => new Response(null, { status: 404 }))
    try {
      const caddy = CaddyClient.start(CADDY_CONFIG)
      await caddy.remove("never-was")
    } finally {
      mock.restore()
    }
  })

  test("remove throws on a real failure", async () => {
    const mock = mockFetch(() => new Response("boom", { status: 500 }))
    try {
      const caddy = CaddyClient.start(CADDY_CONFIG)
      await expect(caddy.remove("d1")).rejects.toThrow()
    } finally {
      mock.restore()
    }
  })
})

describe("GuardedCaddy", () => {
  /** A Caddy sync is never allowed to fail its caller. */
  const broken: Caddy = {
    upsert: async () => {
      throw new Error("caddy is down")
    },
    remove: async () => {
      throw new Error("caddy is down")
    },
  }

  test("swallows a failing upsert and remove", async () => {
    const safe = new GuardedCaddy(broken)
    await safe.upsert("d1", "x.test")
    await safe.remove("d1")
  })
})

describe("reconcileCaddy", () => {
  test("upserts every active domain and skips archived ones", async () => {
    const db = await createTestDb()
    const active1 = Bun.randomUUIDv7()
    const active2 = Bun.randomUUIDv7()
    const archived = Bun.randomUUIDv7()
    await db
      .insertInto("domains")
      .values([
        { id: active1, host: "active-one.test", status: "active" },
        { id: active2, host: "active-two.test", status: "active" },
        { id: archived, host: "archived-one.test", status: "archived" },
      ])
      .execute()

    const upserts: Array<[string, string]> = []
    const spy: Caddy = {
      upsert: async (domain_id, host) => void upserts.push([domain_id, host]),
      remove: async () => {},
    }
    await new DomainService(db, new NoopCacheAdapter(), spy, {
      LINQ_APP_HOST: "app.test",
    }).reconcileCaddy()

    expect(upserts).toHaveLength(3)
    expect(upserts).toContainEqual([active1, "active-one.test"])
    expect(upserts).toContainEqual([active2, "active-two.test"])
    // LINQ_APP_HOST is no domain row but still needs a route.
    expect(upserts).toContainEqual(["app-host", "app.test"])
  })
})
