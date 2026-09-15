import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startGeo } from "../src/clicks/geo.ts"
import { testConfig } from "./helpers/db.ts"

/**
 * The download is stubbed throughout: these pin the acquisition wiring, not
 * DB-IP's data. The record shape was verified once against the real file, which
 * is what docs/adr/0004 rests on.
 */
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Answers each requested URL from `by`, recording the order they were tried in. */
function stubFetch(by: (url: string) => Response): string[] {
  const seen: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    seen.push(url)
    return by(url)
  }) as typeof fetch

  return seen
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "linq-geo-"))
}

const gz = (bytes: Uint8Array<ArrayBuffer>) => new Response(Bun.gzipSync(bytes))

describe("startGeo", () => {
  test("switched off, it never reaches the network", async () => {
    const seen = stubFetch(() => new Response(null, { status: 500 }))
    const geo = await startGeo({ ...testConfig, LINQ_GEO_ENABLED: false })

    expect(seen).toHaveLength(0)
    expect(geo.lookup("8.8.8.8")).toEqual({ country: null, region: null })
    geo.stop()
  })

  test("a failed download leaves a working lookup behind", async () => {
    const dir = tempDir()
    try {
      stubFetch(() => new Response(null, { status: 503 }))
      const geo = await startGeo({ ...testConfig, LINQ_GEO_ENABLED: true, LINQ_GEO_DIR: dir })

      // The point of the whole failure path: the server still answers requests.
      expect(geo.lookup("8.8.8.8")).toEqual({ country: null, region: null })
      expect(geo.lookup(null)).toEqual({ country: null, region: null })
      geo.stop()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the current month is tried first, and a 404 falls back to the previous one", async () => {
    const dir = tempDir()
    try {
      const body = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
      // Only the second URL serves, so the fallback is what wrote the file.
      let n = 0
      const seen = stubFetch(() => (n++ === 0 ? new Response(null, { status: 404 }) : gz(body)))

      const geo = await startGeo({
        ...testConfig,
        LINQ_GEO_ENABLED: true,
        LINQ_GEO_DIR: dir,
        // Not LINQ_DATA_DIR: the download must land in the geo directory, which is
        // the whole point of splitting the two. See docs/adr/0005.
        LINQ_DATA_DIR: join(dir, "elsewhere"),
      })
      geo.stop()

      expect(seen).toHaveLength(2)
      const month = (url: string) => url.match(/(\d{4})-(\d{2})\.mmdb\.gz$/)?.[0]
      expect(month(seen[0])).toBeTruthy()
      expect(month(seen[1])).toBeTruthy()
      expect((month(seen[1]) as string) < (month(seen[0]) as string)).toBe(true)

      // Written unpacked: the reader gets bytes, not an archive to dig through.
      const path = join(dir, "dbip-country-lite.mmdb")
      expect(existsSync(path)).toBe(true)
      expect(new Uint8Array(await Bun.file(path).arrayBuffer())).toEqual(body)
      expect(existsSync(join(dir, "elsewhere", "dbip-country-lite.mmdb"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a supplied database is read, and nothing is ever downloaded", async () => {
    const dir = tempDir()
    try {
      // Not a real MMDB: it never has to open, only prove the download is skipped.
      const supplied = join(dir, "operators-own.mmdb")
      writeFileSync(supplied, new Uint8Array([0xde, 0xad]))
      const seen = stubFetch(() => new Response(null, { status: 500 }))

      const geo = await startGeo({
        ...testConfig,
        LINQ_GEO_ENABLED: true,
        LINQ_GEO_DIR: dir,
        LINQ_GEO_DB_PATH: supplied,
      })
      geo.stop()

      expect(seen).toHaveLength(0)
      // Nothing of linq's own appeared beside it either.
      expect(existsSync(join(dir, "dbip-country-lite.mmdb"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("switched off beats a supplied database", async () => {
    // The precedence rule, and the one thing here a reader could get backwards:
    // ENABLED decides whether geo runs at all, DB_PATH only where data comes from.
    const seen = stubFetch(() => new Response(null, { status: 500 }))
    const geo = await startGeo({
      ...testConfig,
      LINQ_GEO_ENABLED: false,
      LINQ_GEO_DB_PATH: "/does/not/matter.mmdb",
    })

    expect(seen).toHaveLength(0)
    expect(geo.lookup("8.8.8.8")).toEqual({ country: null, region: null })
    geo.stop()
  })

  test("a supplied database that is not there degrades, it does not throw", async () => {
    const seen = stubFetch(() => new Response(null, { status: 500 }))
    const geo = await startGeo({
      ...testConfig,
      LINQ_GEO_ENABLED: true,
      LINQ_GEO_DB_PATH: join(tmpdir(), "linq-geo-absent", "missing.mmdb"),
    })

    // A missing supplied file must not be worse than a failed download: an NFS
    // blip on restart cannot be allowed to take redirects down.
    expect(seen).toHaveLength(0)
    expect(geo.lookup("8.8.8.8")).toEqual({ country: null, region: null })
    geo.stop()
  })
})
