import { describe, expect, test } from "bun:test"
import { clientBaseSegment, isReservedSlug, loadConfig } from "../src/config.ts"

describe("cache configuration", () => {
  test("defaults the memory sweep interval to 60 seconds", () => {
    expect(loadConfig({ DATABASE_URL: "memory://pglite" }).LINQ_CACHE_SWEEP_INTERVAL).toBe(60)
  })

  test("accepts an independent memory sweep interval", () => {
    const config = loadConfig({
      DATABASE_URL: "memory://pglite",
      LINQ_CACHE_TTL: "300",
      LINQ_CACHE_SWEEP_INTERVAL: "15",
    })

    expect(config.LINQ_CACHE_TTL).toBe(300)
    expect(config.LINQ_CACHE_SWEEP_INTERVAL).toBe(15)
  })
})

describe("Client UI base path configuration", () => {
  test("defaults to /home", () => {
    expect(loadConfig({ DATABASE_URL: "memory://pglite" }).LINQ_CLIENT_BASE_PATH).toBe("/home")
  })

  test("accepts a multi-segment path and reserves its first segment", () => {
    const config = loadConfig({
      DATABASE_URL: "memory://pglite",
      LINQ_CLIENT_BASE_PATH: "/admin/example",
    })

    expect(config.LINQ_CLIENT_BASE_PATH).toBe("/admin/example")
    expect(clientBaseSegment(config.LINQ_CLIENT_BASE_PATH)).toBe("admin")
    expect(isReservedSlug("ADMIN", config.LINQ_CLIENT_BASE_PATH)).toBe(true)
    expect(isReservedSlug("campaign", config.LINQ_CLIENT_BASE_PATH)).toBe(false)
  })
})
