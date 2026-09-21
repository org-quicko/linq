import type { BaseQueryFn } from "@reduxjs/toolkit/query/react"
import { createApi } from "@reduxjs/toolkit/query/react"
import { ApiError, api } from "../api"

/**
 * Adapts the existing `api()` fetch wrapper to RTK Query's `baseQuery` shape,
 * so its 401-disconnect-and-redirect behaviour keeps running unchanged instead
 * of being reimplemented here.
 */
const baseQuery: BaseQueryFn<
  { path: string; method?: string; body?: unknown },
  unknown,
  { status: number; code: string; message: string }
> = async ({ path, method, body }) => {
  try {
    const data = await api(path, {
      method,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    // A 204 response resolves `data` to `undefined`; RTK Query requires the
    // `data` key itself to be present and not `undefined` to accept the result.
    return { data: data ?? null }
  } catch (err) {
    if (err instanceof ApiError) {
      return { error: { status: err.status, code: err.code, message: err.message } }
    }
    return { error: { status: 0, code: "unknown", message: (err as Error).message } }
  }
}

/**
 * The one `createApi` for the whole app. Each feature injects its own
 * endpoints from its own file rather than listing them all here.
 */
export const apiSlice = createApi({
  reducerPath: "api",
  baseQuery,
  tagTypes: ["Link", "Domain", "User", "Key", "Stats", "Visit", "QrCode"],
  endpoints: () => ({}),
})
