import type { Principal } from "@linq/shared"
import type { Context, Next } from "hono"
import { HttpError } from "../libs/index.ts"
import { Logger } from "../libs/logger.ts"
import { UrlUtil } from "../utils/index.ts"

/** A caller-supplied id is echoed back only when it is one safe token. */
const REQUEST_ID = /^[\w-]{1,64}$/

/**
 * Logs one `request`/`response` pair and opens the async scope every `@Log` and
 * `Logger.forRequest()` beneath it reads from.
 *
 * What is deliberately absent: the client address, `x-forwarded-for`, query
 * string *values*, and any response body. See resources/docs/adr/0003 — a log file is a
 * second copy of whatever it records, and `POST /keys` returns a
 * plaintext key.
 *
 * @param clientBasePath - LINQ_CLIENT_BASE_PATH; the UI's `_next/` chunk requests are not logged.
 * @returns The middleware.
 */
export function requestLogger(clientBasePath: string) {
  return async (c: Context, next: Next): Promise<void> => {
    const inbound = c.req.header("x-request-id")
    // Validated, not trusted: an arbitrary header would let a caller inject
    // newlines into an NDJSON file and forge entries, or spend the disk budget.
    const reqId = inbound && REQUEST_ID.test(inbound) ? inbound : Bun.randomUUIDv7()
    c.header("x-request-id", reqId)

    // One admin page load is ~30 hashed chunk requests. None of them is diagnostic.
    if (c.req.path.startsWith(UrlUtil.clientPath(clientBasePath, "/_next/"))) return next()

    const child = Logger.child({ reqId })
    await Logger.requestLogStore.run(child, async () => {
      const method = c.req.method
      const path = c.req.path
      child.info({ method, path }, "request")
      if (child.isLevelEnabled("debug")) {
        // Keys only: a link forwards arbitrary customer query strings.
        const query = [...new URL(c.req.url).searchParams.keys()]
        child.debug({ method, path, params: c.req.param(), query }, "request params")
      }

      const requestStartTime = performance.now()
      const done = (status: number) => {
        const principal = c.get("principal") as Principal | undefined
        child.info(
          {
            method,
            path,
            route: c.req.matchedRoutes.at(-1)?.path ?? path,
            status,
            ms: Logger.elapsed(requestStartTime),
            keyId: principal?.keyId ?? null,
          },
          "response",
        )
      }

      try {
        await next()
        done(c.res.status)
      } catch (err) {
        // Reached only when nothing downstream handled the throw, which an app with
        // an `onError` never does: there the error is logged and answered inside
        // `next()`. This is the fallback, so the pair is never left half-written.
        done(err instanceof HttpError ? err.status : 500)
        throw err
      }
    })
  }
}
