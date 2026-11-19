import { ERROR_STATUS, type ErrorBody, type ErrorCode } from "@linq/shared"
import { HTTPException } from "hono/http-exception"
import type { ContentfulStatusCode } from "hono/utils/http-status"

/**
 * Hono's `HTTPException` carrying a linq error `code`. Thrown anywhere in the
 * server; `getResponse()` renders the `{ error: { code, message, details? } }`
 * envelope with the status `ERROR_STATUS[code]` maps to.
 */
export class HttpError extends HTTPException {
  readonly code: ErrorCode
  readonly details?: unknown[]

  /** `status` defaults to `ERROR_STATUS[code]`; only `from` passes another. */
  constructor(
    code: ErrorCode,
    message: string,
    details?: unknown[],
    status: ContentfulStatusCode = ERROR_STATUS[code],
  ) {
    super(status, { message })
    this.name = "HttpError"
    this.code = code
    this.details = details
  }

  /** The wire format every error response uses. */
  get body(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    }
  }

  /** The JSON envelope at this error's status, typed exactly as `c.json` would. */
  override getResponse(): Response {
    return new Response(JSON.stringify(this.body), {
      status: this.status,
      headers: { "content-type": "application/json" },
    })
  }

  /**
   * Re-expresses a bare `HTTPException` (one Hono threw itself, e.g. malformed
   * JSON in a validator) in linq's envelope, keeping its status. The code is
   * the one `ERROR_STATUS` maps that status to, else `internal`.
   */
  static from(err: HTTPException): HttpError {
    if (err instanceof HttpError) return err
    const code = (Object.keys(ERROR_STATUS) as ErrorCode[]).find(
      (k) => ERROR_STATUS[k] === err.status,
    )
    return new HttpError(
      code ?? "internal",
      err.message || "internal server error",
      undefined,
      err.status,
    )
  }

  /** 404. `what` names the resource, e.g. `notFound("link")`. */
  static notFound(what: string) {
    return new HttpError("not_found", `${what} not found`)
  }
  /** 403: the caller is known but not allowed to do this. */
  static forbidden(message = "insufficient permissions") {
    return new HttpError("forbidden", message)
  }
  /** 401: the caller could not be identified at all. */
  static unauthorized(message = "invalid API key") {
    return new HttpError("unauthorized", message)
  }
  /** 409: the request is well formed but fights the current state. */
  static conflict(message: string) {
    return new HttpError("conflict", message)
  }
  /** 429. The caller may retry after the response's Retry-After value. */
  static rateLimited(message = "rate limit exceeded") {
    return new HttpError("rate_limited", message)
  }
  /** 400, carrying the zod issues as `details`. */
  static validation(message: string, details?: unknown[]) {
    return new HttpError("validation_failed", message, details)
  }
}
