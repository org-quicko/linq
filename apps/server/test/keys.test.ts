import { describe, expect, test } from "bun:test"
import { generateKey, hashKey, keyPrefix } from "../src/auth/keys.ts"
import { extractToken } from "../src/auth/middleware.ts"

describe("api keys", () => {
  test("generated keys are prefixed, unique and hash stably", () => {
    const a = generateKey()
    const b = generateKey()
    expect(a).toStartWith("linq_")
    expect(a).not.toBe(b)
    expect(hashKey(a)).toBe(hashKey(a))
    expect(hashKey(a)).not.toBe(hashKey(b))
    expect(hashKey(a)).toMatch(/^[0-9a-f]{64}$/)
  })

  test("the stored prefix is the first 12 characters", () => {
    const key = generateKey()
    expect(keyPrefix(key)).toBe(key.slice(0, 12))
    expect(keyPrefix(key)).toHaveLength(12)
  })
})

describe("extractToken", () => {
  const h = (init: Record<string, string>) => new Headers(init)

  test("reads a bearer token", () => {
    expect(extractToken(h({ authorization: "Bearer linq_abc" }))).toBe("linq_abc")
    expect(extractToken(h({ authorization: "bearer linq_abc" }))).toBe("linq_abc")
  })

  test("falls back to X-Api-Key", () => {
    expect(extractToken(h({ "x-api-key": "linq_abc" }))).toBe("linq_abc")
  })

  test("ignores other schemes and empty values", () => {
    expect(extractToken(h({ authorization: "Basic abc" }))).toBeNull()
    expect(extractToken(h({ authorization: "Bearer " }))).toBeNull()
    expect(extractToken(h({}))).toBeNull()
  })
})
