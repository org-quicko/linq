/**
 * The servers this browser knows about.
 *
 * A server is a linq instance the UI can talk to. The Client UI is served by one
 * of them, but it is not bound to it: a record carries an absolute URL, so the
 * same UI drives an instance anywhere, and the list is what the landing page
 * offers when nothing is connected yet.
 *
 * All of it lives in this browser and never leaves it. The API key is stored in
 * plain text, exactly as the single key it replaces was; localStorage is what
 * this app has, and a key is the only credential linq issues.
 */

const SERVERS_KEY = "linq.servers"
const ACTIVE_KEY = "linq.activeServerId"

/** The pre-multi-server key, read once by `migrateLegacyKey` and then dropped. */
const LEGACY_KEY = "linq.apiKey"

export type Server = {
  id: string
  /** The user's own label for it. */
  name: string
  /**
   * Absolute origin, no `/api` and no trailing slash. Never empty.
   *
   * Nothing depends on being hosted by the server it administers: being served
   * by one grants the UI no implicit address and no implicit credential. That is
   * what lets the same build run from a linq server at `/home` and from a
   * static host at a domain root.
   */
  apiUrl: string
  apiKey: string
}

/** Server-rendered at build time, where there is no storage to read. */
const hasStorage = () => typeof window !== "undefined"

function read<T>(key: string, fallback: T): T {
  if (!hasStorage()) return fallback
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    // Disabled storage, or a value some earlier version wrote that no longer
    // parses. Either way the app has to start, so it starts empty.
    return fallback
  }
}

function write(key: string, value: unknown): void {
  if (!hasStorage()) return
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage disabled or full. The session still works; it just will not
    // outlive the tab, which beats refusing to run.
  }
}

/** Every saved server, in the order they were added. */
export function listServers(): Server[] {
  const list = read<Server[]>(SERVERS_KEY, [])
  return Array.isArray(list) ? list.filter(isServer) : []
}

/** Guards against a hand-edited or half-written entry poisoning every read. */
function isServer(value: unknown): value is Server {
  const s = value as Server | null
  return (
    !!s &&
    typeof s.id === "string" &&
    typeof s.name === "string" &&
    typeof s.apiUrl === "string" &&
    typeof s.apiKey === "string"
  )
}

export function saveServers(list: Server[]): void {
  write(SERVERS_KEY, list)
}

/** The server every request goes to, or null when nothing is connected. */
export function activeServer(): Server | null {
  const id = read<string | null>(ACTIVE_KEY, null)
  if (!id) return null
  return listServers().find((s) => s.id === id) ?? null
}

export function setActiveServer(id: string | null): void {
  if (!hasStorage()) return
  try {
    if (id === null) window.localStorage.removeItem(ACTIVE_KEY)
    else window.localStorage.setItem(ACTIVE_KEY, JSON.stringify(id))
  } catch {
    // See `write`.
  }
}

/** Adds a verified server and makes it the active one. */
export function addServer(input: Omit<Server, "id">): Server {
  const server: Server = { ...input, id: crypto.randomUUID() }
  saveServers([...listServers(), server])
  setActiveServer(server.id)
  return server
}

export function updateServer(id: string, patch: Partial<Omit<Server, "id">>): void {
  saveServers(listServers().map((s) => (s.id === id ? { ...s, ...patch } : s)))
}

/**
 * Forgets a server. Destroys nothing on the server itself, which is why the UI
 * asks for a plain confirmation rather than a typed one.
 */
export function removeServer(id: string): void {
  saveServers(listServers().filter((s) => s.id !== id))
  if (read<string | null>(ACTIVE_KEY, null) === id) setActiveServer(null)
}

/**
 * Disconnects without forgetting. The record survives so the landing page can
 * offer it again; this is also what a 401 falls back to, since a revoked key
 * must not cost the user the URL they typed.
 */
export function disconnect(): void {
  setActiveServer(null)
}

/**
 * Turns what someone typed into a URL worth trying.
 *
 * A bare host is the common case and plainly means a URL, so it gets a scheme
 * rather than an error. Loopback gets `http`, because nobody runs TLS there;
 * anything else gets `https`, because anything else is the internet.
 *
 * Exported for its own sake: this is a guess, and a guess deserves a test.
 */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "")
  if (!trimmed) return ""
  if (/^https?:\/\//i.test(trimmed)) return trimmed

  const host = trimmed.split(/[:/]/)[0]?.toLowerCase() ?? ""
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]"
  return `${loopback ? "http" : "https"}://${trimmed}`
}

/** Where a server's API lives. */
export function apiBase(server: Server): string {
  return `${server.apiUrl}/api`
}

/**
 * Carries the one server a pre-multi-server browser had into the new list, so
 * an existing user is not silently signed out by this release.
 *
 * The address it records is this page's own origin, because that is the only
 * server the old UI could ever have been talking to. Resolving it once, here, is
 * not the same as keeping a same-origin fallback: what gets stored is an
 * ordinary absolute URL like every other record.
 *
 * Returns true when it converted something, and is a no-op afterwards.
 */
export function migrateLegacyKey(): boolean {
  if (!hasStorage()) return false
  let legacy: string | null = null
  try {
    legacy = window.localStorage.getItem(LEGACY_KEY)
  } catch {
    return false
  }
  if (!legacy || listServers().length > 0) return false

  addServer({ name: "This server", apiUrl: window.location.origin, apiKey: legacy })
  try {
    window.localStorage.removeItem(LEGACY_KEY)
  } catch {
    // Left behind at worst; the guard above stops it being converted twice.
  }
  return true
}

export type ProbeResult =
  | { ok: true; user: { name: string; role: string }; version: string }
  | { ok: false; message: string }

/**
 * Checks a server before it is saved, because a record that cannot answer is
 * how a UI ends up unable to explain why nothing loads.
 *
 * Two questions, two calls: `/api/health` says the URL is reachable and linq is
 * what answers, `/api/v1/me` says the key is good and who it belongs to. A form
 * that only pinged health would happily store a typo'd key.
 */
export async function probeServer(apiUrl: string, apiKey: string): Promise<ProbeResult> {
  const base = `${apiUrl}/api`

  let version: string
  try {
    const res = await fetch(`${base}/health`)
    if (!res.ok) return { ok: false, message: reachedButNotLinq }
    const body = (await res.json()) as { status?: string; version?: string }
    if (body?.status !== "ok") return { ok: false, message: reachedButNotLinq }
    version = body.version ?? "unknown"
  } catch {
    // A blocked cross-origin request and a server that is simply down both
    // arrive here as an opaque TypeError, so the message has to cover both.
    return { ok: false, message: unreachable }
  }

  try {
    const res = await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${apiKey}` } })
    if (res.status === 401) {
      return { ok: false, message: "The server answered, but it rejected that API key." }
    }
    if (!res.ok) return { ok: false, message: `The server answered with ${res.status}.` }
    const body = (await res.json()) as { user?: { name?: string; role?: string } }
    if (!body?.user) return { ok: false, message: reachedButNotLinq }
    return {
      ok: true,
      version,
      user: { name: body.user.name ?? "unknown", role: body.user.role ?? "unknown" },
    }
  } catch {
    return { ok: false, message: unreachable }
  }
}

const unreachable =
  "Could not reach that server. Check the URL, and that the server allows requests from this page."

const reachedButNotLinq = "That URL answered, but it does not look like a linq server."
