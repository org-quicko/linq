import { zValidator } from "@hono/zod-validator"
import { ApiError, uuidSchema } from "@linq/shared"
import { type ZodType, z } from "zod"

/** zValidator that reports through linq's error envelope instead of Hono's. */
export function validate<T extends ZodType>(target: "json" | "query" | "param", schema: T) {
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      throw ApiError.validation("request validation failed", result.error.issues)
    }
  })
}

/** The `:id` route param every resource uses: a UUID. */
export const idParam = validate("param", z.object({ id: uuidSchema }))
