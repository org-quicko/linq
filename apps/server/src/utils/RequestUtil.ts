import type { RequestTarget } from "@linq/shared"
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"

/** Reads the raw parts of a request exactly as Hono's validator does. */
export class RequestUtil {
  /**
   * Reads one part of the request exactly as Hono's validator does, so a
   * controller validating in its own body answers byte-for-byte like the
   * `zValidator` middleware it replaced: a repeated query key becomes an array, a body that is
   * not JSON reads as `{}`.
   *
   * @param c - Hono request context.
   * @param target - Which part of the request to read.
   * @returns The raw, unvalidated value.
   * @throws {HTTPException} 400 "Malformed JSON in request body" on an unparseable JSON body.
   */
  static async read(c: Context, target: RequestTarget): Promise<unknown> {
    if (target === "param") return c.req.param()
    if (target === "query") return RequestUtil.readQuery(c)
    return RequestUtil.readJson(c)
  }

  /**
   * The query string as an object: a key given once maps to its value, a
   * repeated key to every value, in order.
   */
  private static readQuery(c: Context): Record<string, string | string[]> {
    return Object.fromEntries(
      Object.entries(c.req.queries()).map(([k, v]) => (v.length === 1 ? [k, v[0]] : [k, v])),
    )
  }

  /** The JSON body; `{}` when the content type is not JSON. */
  private static async readJson(c: Context): Promise<unknown> {
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
