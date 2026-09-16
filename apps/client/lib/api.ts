import { appUrl } from "./base-path"
import { activeServer, apiBase, disconnect } from "./servers"

/**
 * Where a disconnected visitor lands. Spelled through `appUrl` because the
 * redirect below uses `window.location`, which Next does not rewrite. Every
 * `next/link` and `router` call elsewhere omits the prefix; Next adds it there.
 */
const LANDING_PATH = appUrl("/")

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
 * Calls the API of whichever server is connected, with its key attached.
 *
 * A 401 means that server's key was revoked, expired, or its user was disabled,
 * and there is no refresh flow to attempt. The connection is dropped, but the
 * record is kept: the URL the user typed is still good, only the key is not, so
 * throwing it away would make them retype something that was never wrong.
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const server = activeServer()
  // No connection means no address to call: there is no origin this build can
  // assume. Treated like a 401, because the outcome for the reader is the same.
  if (!server) {
    if (window.location.pathname !== LANDING_PATH) window.location.href = LANDING_PATH
    throw new ApiError(401, "unauthorized", "No server is connected.")
  }

  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${server.apiKey}`)
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json")

  const res = await fetch(`${apiBase(server)}${path}`, { ...init, headers })

  if (res.status === 401) {
    disconnect()
    if (window.location.pathname !== LANDING_PATH) window.location.href = LANDING_PATH
    throw new ApiError(401, "unauthorized", "That API key is no longer valid.")
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error
    throw new ApiError(res.status, error?.code ?? "error", error?.message ?? res.statusText)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/**
 * Reads a message off whatever a catch block caught: an `Error`, or the
 * `{status, code, message}` object an RTK Query mutation's `.unwrap()` throws.
 */
export function errorMessage(err: unknown, fallback: string): string {
  if (
    err &&
    typeof err === "object" &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    return (err as { message: string }).message
  }
  return fallback
}

/** Builds a query string, dropping empty values so the URL stays readable. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value))
  }
  const rendered = search.toString()
  return rendered ? `?${rendered}` : ""
}
