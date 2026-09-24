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
    const unauthorizedLanding = appUrl("/?reason=unauthorized")
    if (window.location.pathname !== LANDING_PATH) window.location.href = unauthorizedLanding
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
 * Reads a message off whatever a catch block caught, for the one caller
 * (the server connection form) that shows a client-crafted diagnostic
 * (`new Error("...")`, no `code`) inline instead of a toast.
 *
 * Anything shaped like an API error — a `code` field, whether a raw
 * `ApiError` or the `{status, code, message}` an RTK Query mutation's
 * `.unwrap()` throws — always falls back to the caller's action-specific
 * text instead: the server's wording (a zod issue, a raw SQL conflict) is
 * meant for logs, not a toast.
 */
export function errorMessage(err: unknown, fallback: string): string {
  if (
    err &&
    typeof err === "object" &&
    typeof (err as { message?: unknown }).message === "string" &&
    !("code" in err)
  ) {
    return (err as { message: string }).message
  }
  return fallback
}

/** An ISO timestamp as the local value a `datetime-local` input expects. Null renders empty. */
export function toDatetimeLocal(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The reverse of `toDatetimeLocal`. Empty means "never expires". */
export function fromDatetimeLocal(value: string): string | null {
  return value ? new Date(value).toISOString() : null
}

/** Adds `https://` when a URL is typed without a scheme, so a destination
 *  field never forces the user to type the absolute URL themselves. */
export function withScheme(value: string): string {
  const trimmed = value.trim()
  return trimmed && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? `https://${trimmed}` : trimmed
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
