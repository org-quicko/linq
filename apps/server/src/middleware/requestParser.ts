import { type RequestTarget, uuidSchema } from "@linq/shared"
import type { Context } from "hono"
import { type ZodType, z } from "zod"
import { HttpError } from "../libs/index.ts"
import { RequestUtil } from "../utils/index.ts"

/** The `:id` route param every resource uses: a UUID. */
export const idParamSchema = z.object({ id: uuidSchema })

/**
 * Validates one part of the request against a zod schema, for controllers,
 * whose plain `(c: Context)` signature `c.req.valid()` typing cannot reach.
 * Reads it through `RequestUtil.read`, so it answers byte-for-byte like Hono's
 * own `zValidator` would, malformed-JSON 400 included.
 *
 * @param c - Hono request context.
 * @param target - Which part of the request to validate: `json` body, `query` or route `param`s.
 * @param schema - The zod schema to parse it with.
 * @returns The parsed, typed value.
 * @throws {HttpError} 400 `validation_failed`, carrying the zod issues, when it does not parse.
 * @throws {HTTPException} 400 "Malformed JSON in request body" on an unparseable JSON body.
 */
export async function parseRequest<T extends ZodType>(
  c: Context,
  target: RequestTarget,
  schema: T,
): Promise<z.output<T>> {
  const result = await schema.safeParseAsync(await RequestUtil.read(c, target))
  if (!result.success) throw HttpError.validation("request validation failed", result.error.issues)
  return result.data
}
