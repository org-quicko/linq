import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import type { Config } from "../src/config.ts"
import type { Env } from "../src/http/env.ts"
import { flushLogs, initLogger, log, reqLog, span, withRequestLog } from "../src/log.ts"
import { createHarness } from "./helpers/app.ts"
import { testConfig } from "./helpers/db.ts"

/** The boot-time secrets every scrubbing assertion below is written against. */
const SECRETS = {
  DATABASE_URL: "postgres://linq:sup3rs3cretpw@db.internal:5432/linq",
} satisfies Partial<Config>

type Captured = {
  lines: string[]
  text: () => string
  entries: () => Record<string, unknown>[]
  find: (msg: string) => Record<string, unknown> | undefined
}

/** Points the process logger at an in-memory sink instead of stdout. */
async function capture(overrides: Partial<Config> = {}): Promise<Captured> {
  const lines: string[] = []
  await initLogger(
    { ...testConfig, ...SECRETS, LINQ_LOG_LEVEL: "debug", LINQ_LOG_FILE: "", ...overrides },
    { write: (line) => lines.push(line) },
  )
  const entries = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>)
  return {
    lines,
    text: () => lines.join(""),
    entries,
    find: (msg) => entries().find((e) => e.msg === msg),
  }
}

// Back to the silent default, so a later suite in the same process stays quiet.
afterEach(async () => {
  await initLogger(testConfig, { write: () => {} })
})

describe("plumbing", () => {
  test("a default harness logs nothing at all", async () => {
    const out = await capture({ LINQ_LOG_LEVEL: "silent" })
    const h = await createHarness()
    await h.request("/api/health")
    expect(out.lines).toHaveLength(0)
  })

  test("every request gets a start and an end line", async () => {
    const out = await capture()
    const h = await createHarness()
    await h.request("/api/health")

    const start = out.find("request")
    const end = out.find("response")
    expect(start).toMatchObject({ method: "GET", path: "/api/health" })
    expect(end).toMatchObject({ method: "GET", path: "/api/health", status: 200, keyId: null })
    expect(typeof end?.ms).toBe("number")
  })

  test("a request id is generated, echoed on the response and stamped on every line", async () => {
    const out = await capture()
    const h = await createHarness()
    const res = await h.request("/api/health")

    const reqId = res.headers.get("x-request-id")
    expect(reqId).toMatch(/^[\w-]+$/)
    for (const entry of out.entries()) expect(entry.reqId).toBe(reqId)
  })

  test("a caller-supplied request id is reused", async () => {
    await capture()
    const h = await createHarness()
    const res = await h.request("/api/health", { headers: { "x-request-id": "trace-abc-123" } })
    expect(res.headers.get("x-request-id")).toBe("trace-abc-123")
  })

  test("a request id that could forge log entries is replaced, not echoed", async () => {
    await capture()
    const h = await createHarness()

    // A raw newline never gets this far — `Headers` rejects it — so the values
    // here are the ones that do arrive: JSON punctuation, spaces, and a length
    // that would spend the disk budget a request at a time.
    for (const forged of ['{"msg":"forged"}', "has spaces", "x".repeat(65)]) {
      const res = await h.request("/api/health", { headers: { "x-request-id": forged } })
      expect(res.headers.get("x-request-id")).not.toBe(forged)
      expect(res.headers.get("x-request-id")).toMatch(/^[\w-]+$/)
    }
  })

  test("the acting user lands on the response line", async () => {
    const out = await capture()
    const h = await createHarness()
    const admin = await h.actor("admin")
    await h.request("/api/v1/me", { key: admin.key })
    expect(out.find("response")).toMatchObject({ status: 200, keyId: admin.keyId })
  })

  test("the request id survives an await on the database driver", async () => {
    // `link.findActive` only starts after `domain.findActive` has awaited a
    // query, so a matching reqId proves async storage crosses the driver.
    const out = await capture()
    const h = await createHarness()
    const domain_id = await h.createDomain("localhost")
    const { key } = await h.actor("editor")
    const link = await h.createLink(key, domain_id, { slug: "traced" })

    out.lines.length = 0
    await h.request(`/${link.slug}`)

    const reqId = out.find("request")?.reqId
    expect(reqId).toBeTruthy()
    const found = out.entries().filter((e) => e.op === "link.findActive")
    expect(found.length).toBeGreaterThan(0)
    for (const entry of found) expect(entry.reqId).toBe(reqId)
  })
})

describe("spans", () => {
  test("a span brackets its work with a duration", async () => {
    const out = await capture()
    const value = await span("demo", async () => 42, {
      in: { a: 1 },
      out: (v) => ({ answer: v }),
    })

    expect(value).toBe(42)
    const [start, end] = out.entries()
    expect(start).toMatchObject({ op: "demo", msg: "demo start", params: { a: 1 } })
    expect(end).toMatchObject({ op: "demo", ok: true, result: { answer: 42 } })
    expect(typeof end?.ms).toBe("number")
  })

  test("a failing span records the failure and rethrows without serialising it", async () => {
    const out = await capture()
    const boom = new Error("boom: this stack must not be logged here")

    await expect(
      span("demo", async () => {
        throw boom
      }),
    ).rejects.toThrow("boom")

    expect(out.find("demo end")).toMatchObject({ ok: false })
    expect(out.text()).not.toContain("this stack must not be logged here")
  })

  test("an unhandled error is logged once, inside the request scope", async () => {
    const out = await capture()

    // A bare app rather than the harness: nothing in the real one throws a
    // non-ApiError on demand, and the wiring is what is under test.
    const app = new Hono<Env>()
    app.use("*", withRequestLog)
    app.onError((err, c) => {
      reqLog().error({ err }, "unhandled error")
      // `c.text`, not a bare Response: only a context-built response carries the
      // headers the middleware set, the request id among them.
      return c.text("boom", 500)
    })
    app.get("/boom", () => {
      throw new Error("kaboom-detail")
    })

    const res = await app.fetch(new Request("http://localhost/boom"))
    expect(res.status).toBe(500)

    const failures = out.entries().filter((e) => e.msg === "unhandled error")
    expect(failures).toHaveLength(1)
    // Hono runs `onError` inside the composed chain, so the request scope is
    // still open there. Without that, the one stack we keep would have no id.
    expect(failures[0]?.reqId).toBe(res.headers.get("x-request-id"))
    expect(out.text()).toContain("kaboom-detail")
    expect(out.find("response")).toMatchObject({ status: 500 })
  })

  test("an ApiError is an answer, not a fault, so no error line is written", async () => {
    const out = await capture()
    const h = await createHarness()
    const res = await h.request("/api/v1/links")

    expect(res.status).toBe(401)
    expect(out.entries().some((e) => e.msg === "unhandled error")).toBe(false)
    expect(out.find("response")).toMatchObject({ status: 401 })
  })

  test("a span below the configured level costs nothing", async () => {
    const out = await capture({ LINQ_LOG_LEVEL: "info" })
    await span("quiet", async () => 1, { level: "debug" })
    expect(out.lines).toHaveLength(0)
  })
})

describe("secrets never reach the log", () => {
  test("not the bearer token on an authenticated request", async () => {
    const out = await capture()
    const h = await createHarness()
    const admin = await h.actor("admin")
    await h.request("/api/v1/me", { key: admin.key })

    expect(out.lines.length).toBeGreaterThan(0)
    expect(out.text()).not.toContain(admin.key)
  })

  test("not a freshly minted key, whose response body carries it in plaintext", async () => {
    const out = await capture()
    const h = await createHarness()
    const admin = await h.actor("admin")

    const res = await h.post("/api/v1/keys", admin.key, { name: "ci", preset: "viewer" })
    expect(res.status).toBe(201)
    const { secret } = await res.json()

    expect(secret).toBeTruthy()
    expect(out.text()).not.toContain(secret)
  })

  test("not the config object, even when something dumps it wholesale", async () => {
    const out = await capture()
    log.info({ config: { ...testConfig, ...SECRETS } }, "careless")
    log.info({ inner: { config: { ...testConfig, ...SECRETS } } }, "careless, nested")

    const text = out.text()
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret)
    expect(text).toContain("[redacted]")
  })

  test("not the DSN password smuggled inside a driver error", async () => {
    const out = await capture()
    log.error(
      { err: new Error(`failed to connect to ${SECRETS.DATABASE_URL}`) },
      "visit insert failed",
    )

    const text = out.text()
    expect(text).not.toContain(SECRETS.DATABASE_URL)
    expect(text).not.toContain("sup3rs3cretpw")
  })

  test("no boot-time secret appears anywhere across a whole request", async () => {
    const out = await capture()
    const h = await createHarness()
    const admin = await h.actor("admin")
    await h.request("/api/v1/keys", { key: admin.key })

    const text = out.text()
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret)
  })
})

describe("privacy", () => {
  test("a client address is never written, not even at debug (adr 0003)", async () => {
    const out = await capture()
    const h = await createHarness()
    const domain_id = await h.createDomain("localhost", "https://example.com/fallback")

    await h.request("/nothing-here?utm_source=news", {
      headers: { "x-forwarded-for": "203.0.113.42, 198.51.100.7" },
    })

    const text = out.text()
    expect(text).not.toContain("203.0.113.42")
    expect(text).not.toContain("198.51.100.7")
    expect(text).not.toContain("x-forwarded-for")
    expect(domain_id).toBeTruthy()
  })

  test("query keys are logged but their values are not", async () => {
    const out = await capture()
    const h = await createHarness()
    await h.createDomain("localhost", "https://example.com/fallback")
    await h.request("/nothing-here?token=hunter2barbaz")

    const text = out.text()
    expect(text).toContain("token")
    expect(text).not.toContain("hunter2barbaz")
  })
})

describe("rotation", () => {
  test("the file rolls at LINQ_LOG_MAX_SIZE and old files are pruned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "link-log-"))
    try {
      // A discarding sink stands in for stdout, so the file is the only output.
      await initLogger(
        {
          ...testConfig,
          LINQ_LOG_LEVEL: "info",
          LINQ_LOG_FILE: join(dir, "linq.log"),
          LINQ_LOG_MAX_SIZE: "1k",
          LINQ_LOG_RETAIN: 2,
        },
        { write: () => {} },
      )

      for (let i = 0; i < 400; i++) log.info({ i }, "filling the file up")
      await flushLogs()
      await Bun.sleep(200)

      const files = readdirSync(dir)
      expect(files.length).toBeGreaterThanOrEqual(2)
      // RETAIN keeps that many rotated files in addition to the active one.
      expect(files.length).toBeLessThanOrEqual(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
