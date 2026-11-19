import { AsyncLocalStorage } from "node:async_hooks"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { Sink } from "@linq/shared"
import pino, { type Logger as PinoLogger } from "pino"
import pinoRoll from "pino-roll"
import type { Config } from "../config.ts"

type Flushable = Sink & { flush(): Promise<void> }

export class Logger {
  private static base: PinoLogger = pino({ level: "silent" })
  private static sink: Flushable | null = null
  private static secrets: string[] = []
  static readonly requestLogStore = new AsyncLocalStorage<PinoLogger>()
  private static readonly REDACT_PATHS = [
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
  static get info() {
    return Logger.base.info.bind(Logger.base)
  }
  static get warn() {
    return Logger.base.warn.bind(Logger.base)
  }
  static get error() {
    return Logger.base.error.bind(Logger.base)
  }
  static child(bindings: pino.Bindings) {
    return Logger.base.child(bindings)
  }

  /**
   * Every form a boot-time secret can take inside a line we did not build: raw, the
   * URL-encoded form, and the JSON-escaped form pino writes.
   */
  private static collectSecrets(config: Config): string[] {
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

  /** The rotating file, or null when `LINQ_LOG_FILE` is empty. */
  private static async fileSink(config: Config): Promise<Flushable | null> {
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
  static async init(config: Config, destination?: Sink): Promise<void> {
    Logger.secrets = Logger.collectSecrets(config)

    // `destination` stands in for stdout, not for the file: a test can capture
    // lines while still exercising rotation, and one that wants neither sets
    // `LINQ_LOG_FILE` to "".
    const file = await Logger.fileSink(config)
    const primary: Sink = destination ?? process.stdout

    Logger.sink = {
      // One scrub covers both destinations; pino emits exactly one write per line.
      write(line: string) {
        let clean = line
        for (const secret of Logger.secrets) clean = clean.replaceAll(secret, "[redacted]")
        primary.write(clean)
        file?.write(clean)
      },
      flush: () => file?.flush() ?? Promise.resolve(),
    }

    Logger.base = pino(
      {
        level: config.LINQ_LOG_LEVEL,
        redact: { paths: Logger.REDACT_PATHS, censor: "[redacted]" },
      },
      Logger.sink,
    )
  }

  /** Drains buffered writes. Called on shutdown, or the last lines are lost. */
  static async flush(): Promise<void> {
    await Logger.sink?.flush()
  }

  /** The logger for the request in flight, or the base one outside a request. */
  static forRequest(): PinoLogger {
    return Logger.requestLogStore.getStore() ?? Logger.base
  }

  /** Milliseconds since the operation began, to one decimal place. */
  static elapsed(operationStartTime: number): number {
    return Number((performance.now() - operationStartTime).toFixed(1))
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
  static async operation<T>(
    name: string,
    fn: () => Promise<T>,
    io: { in?: () => object; out?: (value: T) => object; level?: "info" | "debug" } = {},
  ): Promise<T> {
    const logger = Logger.forRequest()
    const level = io.level ?? "info"
    if (!logger.isLevelEnabled(level)) return fn()

    const debug = logger.isLevelEnabled("debug")
    logger[level]({ op: name, ...(debug && io.in ? { params: io.in() } : {}) }, `${name} start`)

    const operationStartTime = performance.now()
    try {
      const value = await fn()
      const result = debug && io.out ? { result: io.out(value) } : {}
      logger[level](
        { op: name, ms: Logger.elapsed(operationStartTime), ok: true, ...result },
        `${name} end`,
      )
      return value
    } catch (err) {
      logger[level]({ op: name, ms: Logger.elapsed(operationStartTime), ok: false }, `${name} end`)
      throw err
    }
  }
}

/**
 * Logs an asynchronous method's start, completion and duration. Projections run
 * only at debug level; arguments and return values are never dumped implicitly.
 * Uses standard decorators, preserving the receiver and the original failure.
 */
export function Log<Args extends unknown[] = unknown[], Result = unknown>(
  name?: string,
  options: {
    in?: (...args: Args) => object
    out?: (value: Result) => object
    level?: "info" | "debug"
  } = {},
) {
  return <This, MethodArgs extends [...Args, ...unknown[]], MethodResult extends Result>(
    method: (this: This, ...args: MethodArgs) => Promise<MethodResult>,
    context: ClassMethodDecoratorContext<
      This,
      (this: This, ...args: MethodArgs) => Promise<MethodResult>
    >,
  ) =>
    function (this: This, ...args: MethodArgs): Promise<MethodResult> {
      const inputProjection = options.in
      return Logger.operation(name ?? String(context.name), () => method.apply(this, args), {
        in: inputProjection ? () => Reflect.apply(inputProjection, undefined, args) : undefined,
        out: options.out,
        level: options.level,
      })
    }
}
