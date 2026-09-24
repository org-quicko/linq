export const ERROR_STATUS = {
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
} as const

export type ErrorCode = keyof typeof ERROR_STATUS

export type ErrorBody = {
  error: {
    code: ErrorCode
    message: string
    details?: unknown[]
  }
}

/** Thrown anywhere in the server; rendered by the Hono error handler. */
export class ApiError extends Error {
  readonly code: ErrorCode
  readonly details?: unknown[]

  constructor(code: ErrorCode, message: string, details?: unknown[]) {
    super(message)
    this.name = "ApiError"
    this.code = code
    this.details = details
  }

  /** The HTTP status this code maps to. */
  get status(): number {
    return ERROR_STATUS[this.code]
  }

  /** Renders the wire format every error response uses. */
  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    }
  }

  /** 404. `what` names the resource, e.g. `notFound("link")`. */
  static notFound(what: string) {
    return new ApiError("not_found", `${what} not found`)
  }
  /** 403: the caller is known but not allowed to do this. */
  static forbidden(message = "insufficient permissions") {
    return new ApiError("forbidden", message)
  }
  /** 401: the caller could not be identified at all. */
  static unauthorized(message = "invalid API key") {
    return new ApiError("unauthorized", message)
  }
  /** 409: the request is well formed but fights the current state. */
  static conflict(message: string) {
    return new ApiError("conflict", message)
  }
  /** 429. The caller may retry after the response's Retry-After value. */
  static rateLimited(message = "rate limit exceeded") {
    return new ApiError("rate_limited", message)
  }
  /** 400, carrying the zod issues as `details`. */
  static validation(message: string, details?: unknown[]) {
    return new ApiError("validation_failed", message, details)
  }
}
