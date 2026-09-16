import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import {
  activeServer,
  addServer,
  apiBase,
  disconnect,
  listServers,
  migrateLegacyKey,
  normalizeUrl,
  removeServer,
  saveServers,
  setActiveServer,
  updateServer,
} from "../lib/servers.ts"

/**
 * The store reads `window.localStorage`, so the suite supplies one. Bun has no
 * DOM; this is the whole of what `lib/servers.ts` touches.
 */
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
}

const storage = new MemoryStorage()

// Anything that looks for a browser finds one once this is set — PGlite sniffs
// `window` exactly this way — so it is removed again the moment the suite ends
// rather than left lying around for whatever test file runs next.
// biome-ignore lint/suspicious/noExplicitAny: standing in for the browser global
;(globalThis as any).window = {
  localStorage: storage,
  location: { pathname: "/", origin: "https://served-from.test" },
}

afterAll(() => {
  // biome-ignore lint/suspicious/noExplicitAny: removing the stub above
  ;(globalThis as any).window = undefined
})

beforeEach(() => storage.clear())

describe("normalizeUrl", () => {
  test("keeps a URL that already has a scheme", () => {
    expect(normalizeUrl("https://linq.example.com")).toBe("https://linq.example.com")
    expect(normalizeUrl("http://10.0.0.5:3000")).toBe("http://10.0.0.5:3000")
  })

  test("assumes https for a bare host, because that is the internet", () => {
    expect(normalizeUrl("linq.example.com")).toBe("https://linq.example.com")
    expect(normalizeUrl("linq.example.com:8080")).toBe("https://linq.example.com:8080")
  })

  test("assumes http for loopback, because nobody runs TLS there", () => {
    expect(normalizeUrl("localhost:3000")).toBe("http://localhost:3000")
    expect(normalizeUrl("127.0.0.1:3000")).toBe("http://127.0.0.1:3000")
  })

  test("trims whitespace and trailing slashes, so the base never doubles up", () => {
    expect(normalizeUrl("  https://linq.example.com/  ")).toBe("https://linq.example.com")
    expect(normalizeUrl("https://linq.example.com///")).toBe("https://linq.example.com")
  })

  test("leaves an empty input empty, so the form can reject it", () => {
    expect(normalizeUrl("")).toBe("")
    expect(normalizeUrl("   ")).toBe("")
  })
})

describe("apiBase", () => {
  test("appends /api to an absolute URL", () => {
    expect(apiBase({ id: "1", name: "n", apiUrl: "https://a.test", apiKey: "k" })).toBe(
      "https://a.test/api",
    )
  })
})

describe("the server list", () => {
  test("adds a server and connects to it", () => {
    const server = addServer({ name: "prod", apiUrl: "https://a.test", apiKey: "linq_a" })

    expect(listServers()).toHaveLength(1)
    expect(activeServer()?.id).toBe(server.id)
    expect(activeServer()?.apiKey).toBe("linq_a")
  })

  test("holds several servers and switches between them", () => {
    const a = addServer({ name: "a", apiUrl: "https://a.test", apiKey: "linq_a" })
    const b = addServer({ name: "b", apiUrl: "https://b.test", apiKey: "linq_b" })

    expect(listServers()).toHaveLength(2)
    expect(activeServer()?.id).toBe(b.id)

    setActiveServer(a.id)
    expect(activeServer()?.name).toBe("a")
  })

  test("edits a server in place without disturbing the others", () => {
    const a = addServer({ name: "a", apiUrl: "https://a.test", apiKey: "linq_a" })
    addServer({ name: "b", apiUrl: "https://b.test", apiKey: "linq_b" })

    updateServer(a.id, { apiKey: "linq_rotated" })

    expect(listServers().find((s) => s.id === a.id)?.apiKey).toBe("linq_rotated")
    expect(listServers().find((s) => s.name === "b")?.apiKey).toBe("linq_b")
  })

  test("removing the active server disconnects, removing another does not", () => {
    const a = addServer({ name: "a", apiUrl: "https://a.test", apiKey: "linq_a" })
    const b = addServer({ name: "b", apiUrl: "https://b.test", apiKey: "linq_b" })

    // b is active; dropping a must not move the user.
    removeServer(a.id)
    expect(activeServer()?.id).toBe(b.id)

    removeServer(b.id)
    expect(activeServer()).toBeNull()
    expect(listServers()).toHaveLength(0)
  })

  test("disconnect keeps the record, so a bad key does not lose the URL", () => {
    const a = addServer({ name: "a", apiUrl: "https://a.test", apiKey: "linq_a" })

    disconnect()

    expect(activeServer()).toBeNull()
    expect(listServers().find((s) => s.id === a.id)?.apiUrl).toBe("https://a.test")
  })

  test("an active id pointing at a server that is gone reads as disconnected", () => {
    setActiveServer("never-existed")
    expect(activeServer()).toBeNull()
  })

  test("survives a corrupt stored value instead of taking the app down", () => {
    storage.setItem("linq.servers", "{not json")
    expect(listServers()).toEqual([])

    saveServers([
      { id: "1", name: "ok", apiUrl: "https://a.test", apiKey: "k" },
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed
      { id: 2, name: "bad" } as any,
    ])
    expect(listServers()).toHaveLength(1)
  })
})

describe("migrating the single key that came before", () => {
  test("records this page's own origin as an ordinary absolute URL", () => {
    storage.setItem("linq.apiKey", "linq_existing")

    expect(migrateLegacyKey()).toBe(true)

    const server = activeServer()
    expect(server?.apiKey).toBe("linq_existing")
    // The old UI could not have been talking to anything but its own origin, so
    // that is resolved once here — and stored like any other address, not as a
    // standing same-origin fallback.
    expect(server?.apiUrl).toBe("https://served-from.test")
    expect(apiBase(server as NonNullable<typeof server>)).toBe("https://served-from.test/api")
    expect(storage.getItem("linq.apiKey")).toBeNull()
  })

  test("does nothing when there is no old key", () => {
    expect(migrateLegacyKey()).toBe(false)
    expect(listServers()).toHaveLength(0)
  })

  test("does not run over a browser that already has servers", () => {
    addServer({ name: "a", apiUrl: "https://a.test", apiKey: "linq_a" })
    storage.setItem("linq.apiKey", "linq_stale")

    expect(migrateLegacyKey()).toBe(false)
    expect(listServers()).toHaveLength(1)
  })
})
