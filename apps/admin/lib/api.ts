const STORAGE_KEY = "linq.apiKey"

/** Same origin as the Admin UI: Hono serves both from one port. */
const API_BASE = process.env.NEXT_PUBLIC_LINQ_API ?? "/api"

/**
 * Where a logged-out visitor lands, spelled with the basePath because the
 * redirect below uses `window.location`, which Next does not rewrite. Every
 * `next/link` and `router` call elsewhere omits it; Next adds it there.
 */
const LOGIN_PATH = "/admin/"

/** The API key pasted at login. Null in SSG, where there is no browser storage. */
export function getKey(): string | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

/** Stores the key for later requests. It never leaves this browser. */
export function setKey(key: string): void {
  window.localStorage.setItem(STORAGE_KEY, key)
}

/** Forgets the key. Called on logout and on any 401. */
export function clearKey(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // A browser with storage disabled has nothing to clear.
  }
}

/** An error response from the API, carrying the server's code and status. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
  }
}

/**
 * Calls the linq API with the stored key attached.
 *
 * A 401 means the key was revoked, expired, or its user was disabled, so the
 * key is dropped and the browser is sent back to the login screen: there is no
 * refresh flow to attempt.
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const key = getKey()
  if (key) headers.set("authorization", `Bearer ${key}`)
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json")

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers })

  if (res.status === 401) {
    clearKey()
    if (window.location.pathname !== LOGIN_PATH) window.location.href = LOGIN_PATH
    throw new ApiError(401, "unauthorized", "Your API key is no longer valid.")
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error
    throw new ApiError(res.status, error?.code ?? "error", error?.message ?? res.statusText)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** POST/PATCH/PUT shorthands: every write in the UI goes through one of these. */
export const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) })

export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) })

export const put = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "PUT", body: JSON.stringify(body) })

export const del = <T>(path: string) => api<T>(path, { method: "DELETE" })

/** Builds a query string, dropping empty values so the URL stays readable. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value))
  }
  const rendered = search.toString()
  return rendered ? `?${rendered}` : ""
}
