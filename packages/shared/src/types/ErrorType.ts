import type { ERROR_STATUS } from "../constants/index.ts"

export type ErrorCode = keyof typeof ERROR_STATUS

export type ErrorBody = {
  error: {
    code: ErrorCode
    message: string
    details?: unknown[]
  }
}
