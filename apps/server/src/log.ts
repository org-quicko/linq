import { AsyncLocalStorage } from "node:async_hooks"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { ApiError } from "@linq/shared"
import type { Context, Next } from "hono"
import pino, { type Logger } from "pino"
import pinoRoll from "pino-roll"
import type { Principal } from "./auth/middleware.ts"
import type { Config } from "./config.ts"
import type { Env } from "./http/env.ts"

/** Anything a serialised log line can be handed to. Tests pass an array-backed one. */
export type Sink = { write(line: string): void }
type Flushable = Sink & { flush(): Promise<void> }

/**
 * The process logger. Silent until `initLogger` runs, which only `main.ts` does,
 * so importing this module never makes a test or a script write anything.
 */
export let log: Logger = pino({ level: "silent" })

/**
 * The per-request child logger, carrying `reqId`. Held in async storage rather
 * than threaded through every signature: service functions take `(db, ...)` and
 * several of them run with no request at all.
 */
const als = new AsyncLocalStorage<Logger>()

let sink: Flushable | null = null

/**
 * Boot-time secrets, longest first so a value containing another (a DSN and its
 * password) is matched whole before its substring is rewritten out of reach.
 */
let secrets: string[] = []

/**
 * Field-path redaction. A seatbelt, not the mechanism: the real guarantee is that
 * no call site hands the logger an object it did not build. `config` is listed
 * first because `c.var.config` carries three secrets and rides on every request
 * context. The pino wildcard is single-level, so this covers depth 0 and 1.
 */
const REDACT_PATHS = [
  "config",
  "*.config",
  "secret",
  "*.secret",
  "key_hash",
  "*.key_hash",
  "token",
  "*.token",
  "headers.authorization",
  'headers["x-api-key"]',
  '*.headers["authorization"]',
  '*.headers["x-api-key"]',
]

/**
 * Every form a boot-time secret can take inside a line we did not build: raw, the
 * URL-encoded form, and the JSON-escaped form pino writes.
 */
function collectSecrets(config: Config): string[] {
  const values = [config.DATABASE_URL, config.LINQ_REDIS_URL]
  // The Redis URL is absent on every install that does not use it.
  for (const dsn of [config.DATABASE_URL, config.LINQ_REDIS_URL].filter((v) => v !== undefined)) {
    try {
      values.push(new URL(dsn).password)
    } catch {
      // A DSN the URL parser rejects has no password to pull out of it.
    }
  }

  const out = new Set<string>()
  for (const value of values) {
    // Short values are skipped: scrubbing "1234" would mangle unrelated output.
    if (!value || value.length < 6) continue
    out.add(value)
    out.add(encodeURIComponent(value))
    out.add(JSON.stringify(value).slice(1, -1))
  }
  return [...out].sort((a, b) => b.length - a.length)
}

/** Removes every known boot-time secret from one serialised line. */
function scrub(line: string): string {
  let out = line
  for (const secret of secrets) out = out.replaceAll(secret, "[redacted]")
  return out
}

/** The rotating file, or null when `LINQ_LOG_FILE` is empty. */
async function fileSink(config: Config): Promise<Flushable | null> {
  if (!config.LINQ_LOG_FILE) return null
  await mkdir(dirname(config.LINQ_LOG_FILE), { recursive: true })

  const roll = await pinoRoll({
    file: config.LINQ_LOG_FILE,
    size: config.LINQ_LOG_MAX_SIZE,
    limit: { count: config.LINQ_LOG_RETAIN },
    mkdir: true,
  })

  return {
    write: (line) => roll.write(line),
    flush: () => new Promise((resolve) => roll.flush(() => resolve())),
  }
}

/**
 * Builds the real logger. Called only from `main.ts`, so the suite stays silent
 * and writes no file; `log.test.ts` passes `destination` to capture output.
 *
 * pino writes to the file in-process through the pino-roll SonicBoom stream
 * rather than through `pino.transport()`: a worker-thread transport is the least
 * proven part of pino under Bun, and it loses lines silently when it breaks.
 */
export async function initLogger(config: Config, destination?: Sink): Promise<void> {
  secrets = collectSecrets(config)

  // `destination` stands in for stdout, not for the file: a test can capture
  // lines while still exercising rotation, and one that wants neither sets
  // `LINQ_LOG_FILE` to "".
  const file = await fileSink(config)
  const primary: Sink = destination ?? process.stdout

  sink = {
    // One scrub covers both destinations; pino emits exactly one write per line.
    write(line: string) {
      const clean = scrub(line)
      primary.write(clean)
      file?.write(clean)
    },
    flush: () => file?.flush() ?? Promise.resolve(),
  }

  log = pino(
    { level: config.LINQ_LOG_LEVEL, redact: { paths: REDACT_PATHS, censor: "[redacted]" } },
    sink,
  )
}

/** Drains buffered writes. Called on shutdown, or the last lines are lost. */
export async function flushLogs(): Promise<void> {
  await sink?.flush()
}

/** The logger for the request in flight, or the base one outside a request. */
export function reqLog(): Logger {
  return als.getStore() ?? log
}

function elapsed(started: number): number {
  return Number((performance.now() - started).toFixed(1))
}

/**
 * Wraps one operation in a `start`/`end` pair carrying its duration.
 *
 * `io.in` and `io.out` are mappers, never dumpers: they run only when debug is
 * enabled, and they return the explicit projection to log. Nothing here walks a
 * context, a config or a database row.
 *
 * A failure logs `ok: false` and rethrows **without serialising the error**, so
 * one failed request does not log the same driver error at four nesting levels.
 * `app.onError` logs it once, with the request id.
 */
export async function span<T>(
  name: string,
  fn: () => Promise<T>,
  io: { in?: object; out?: (value: T) => object; level?: "info" | "debug" } = {},
): Promise<T> {
  const l = reqLog()
  const level = io.level ?? "info"
  if (!l.isLevelEnabled(level)) return fn()

  const debug = l.isLevelEnabled("debug")
  l[level]({ op: name, ...(debug && io.in ? { params: io.in } : {}) }, `${name} start`)

  const started = performance.now()
  try {
    const value = await fn()
    const result = debug && io.out ? { result: io.out(value) } : {}
    l[level]({ op: name, ms: elapsed(started), ok: true, ...result }, `${name} end`)
    return value
  } catch (err) {
    l[level]({ op: name, ms: elapsed(started), ok: false }, `${name} end`)
    throw err
  }
}

/** A caller-supplied id is echoed back only when it is one safe token. */
const REQUEST_ID = /^[\w-]{1,64}$/

/**
 * Logs one `request`/`response` pair and opens the async scope every `span` and
 * `reqLog()` beneath it reads from.
 *
 * What is deliberately absent: the client address, `x-forwarded-for`, query
 * string *values*, and any response body. See docs/adr/0003 — a log file is a
 * second copy of whatever it records, and `POST /keys` returns a
 * plaintext key.
 */
export async function withRequestLog(c: Context<Env>, next: Next): Promise<void> {
  const inbound = c.req.header("x-request-id")
  // Validated, not trusted: an arbitrary header would let a caller inject
  // newlines into an NDJSON file and forge entries, or spend the disk budget.
  const reqId = inbound && REQUEST_ID.test(inbound) ? inbound : Bun.randomUUIDv7()
  c.header("x-request-id", reqId)

  // One admin page load is ~30 hashed chunk requests. None of them is diagnostic.
  const clientBasePath = c.var.config?.LINQ_CLIENT_BASE_PATH ?? "/home"
  if (c.req.path.startsWith(`${clientBasePath}/_next/`)) return next()

  const child = log.child({ reqId })
  await als.run(child, async () => {
    const method = c.req.method
    const path = c.req.path
    child.info({ method, path }, "request")
    if (child.isLevelEnabled("debug")) {
      // Keys only: a link forwards arbitrary customer query strings.
      const query = [...new URL(c.req.url).searchParams.keys()]
      child.debug({ method, path, params: c.req.param(), query }, "request params")
    }

    const started = performance.now()
    const done = (status: number) => {
      const principal = c.get("principal") as Principal | undefined
      child.info(
        {
          method,
          path,
          route: c.req.matchedRoutes.at(-1)?.path ?? path,
          status,
          ms: elapsed(started),
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
      done(err instanceof ApiError ? err.status : 500)
      throw err
    }
  })
}
