import type { RequestTarget } from "@linq/shared"
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import type { ZodType, z } from "zod"
import { HttpError } from "../libs/index.ts"

/** Reads and validates the parts of a request exactly as Hono's validator does. */
export class RequestUtil {
  /**
   * Reads one part of the request and validates it against a zod schema, for
   * controllers, whose plain `(c: Context)` signature `c.req.valid()` typing
   * cannot reach. Answers byte-for-byte like Hono's own `zValidator` would,
   * malformed-JSON 400 included.
   *
   * @param c - Hono request context.
   * @param target - Which part of the request to validate: `json` body, `query` or route `param`s.
   * @param schema - The zod schema to parse it with.
   * @returns The parsed, typed value: the schema's output, defaults and coercions applied.
   * @throws {HttpError} 400 `validation_failed`, carrying the zod issues, when it does not parse.
   * @throws {HTTPException} 400 "Malformed JSON in request body" on an unparseable JSON body.
   */
  static async parse<T extends ZodType>(
    c: Context,
    target: RequestTarget,
    schema: T,
  ): Promise<z.output<T>> {
    const result = await schema.safeParseAsync(await RequestUtil.extractInput(c, target))
    if (!result.success)
      throw HttpError.validation("request validation failed", result.error.issues)
    return result.data
  }

  /**
   * The raw, unvalidated input `parse` hands to zod: one part of the request,
   * taken exactly as Hono's validator takes it. A repeated query key becomes an
   * array; a body that is not JSON becomes `{}`.
   *
   * @param c - Hono request context.
   * @param target - Which part of the request to take.
   * @returns The raw, unvalidated value.
   * @throws {HTTPException} 400 "Malformed JSON in request body" on an unparseable JSON body.
   */
  private static async extractInput(c: Context, target: RequestTarget): Promise<unknown> {
    if (target === "param") return RequestUtil.extractRouteParams(c)
    if (target === "query") return RequestUtil.extractQueryParams(c)
    return RequestUtil.extractJsonBody(c)
  }

  /** The route params, e.g. `{ id }` for `/links/:id`. */
  private static extractRouteParams(c: Context): Record<string, string> {
    return c.req.param()
  }

  /**
   * The query string as an object: a key given once maps to its value, a
   * repeated key to every value, in order.
   */
  private static extractQueryParams(c: Context): Record<string, string | string[]> {
    return Object.fromEntries(
      Object.entries(c.req.queries()).map(([k, v]) => (v.length === 1 ? [k, v[0]] : [k, v])),
    )
  }

  /** The JSON body; `{}` when the content type is not JSON. */
  private static async extractJsonBody(c: Context): Promise<unknown> {
    if (!RequestUtil.JSON_CONTENT_TYPE.test(c.req.header("content-type") ?? "")) return {}
    try {
      return await c.req.json()
    } catch {
      // Hono's own message; `app.onError` renders it as `validation_failed`.
      throw new HTTPException(400, { message: "Malformed JSON in request body" })
    }
  }

  /** The same JSON content types Hono's validator accepts; any other body reads as `{}`. */
  private static readonly JSON_CONTENT_TYPE =
    /^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i
}
