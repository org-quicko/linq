import { describe, expect, test } from "bun:test"
import { type Actor, claimsForPreset, defineAbility, type KeyPreset } from "@linq/shared"
import type { Principal } from "../src/libs/context.ts"
import { authorize } from "../src/middleware/authorize.ts"

const principal = (preset: KeyPreset, keyId = "k1"): Principal => {
  const claims = [...claimsForPreset[preset]]
  return { keyId, claims, ability: defineAbility(claims), name: "test" }
}
const allows = (fn: () => void) => {
  try {
    fn()
    return true
  } catch {
    return false
  }
}

describe("CASL authorization", () => {
  test("editor claims create and update links, viewer claims do not", () => {
    expect(allows(() => authorize(principal("editor"), "create", "Link"))).toBe(true)
    expect(allows(() => authorize(principal("editor"), "update", "Link"))).toBe(true)
    expect(allows(() => authorize(principal("viewer"), "create", "Link"))).toBe(false)
  })
  test("archive is a distinct admin claim", () => {
    expect(allows(() => authorize(principal("admin"), "archive", "Link"))).toBe(true)
    expect(allows(() => authorize(principal("editor"), "archive", "Link"))).toBe(false)
  })
  test("a custom claim list grants only its exact CASL action and subject", () => {
    const claims = [{ action: "create", subject: "Domain" }] as const
    const custom: Principal = {
      keyId: "custom",
      name: "custom",
      claims: [...claims],
      ability: defineAbility(claims),
    }
    expect(allows(() => authorize(custom, "create", "Domain"))).toBe(true)
    expect(allows(() => authorize(custom, "update", "Domain"))).toBe(false)
    expect(allows(() => authorize(custom, "create", "Link"))).toBe(false)
  })
})

const actor = (preset: KeyPreset): Actor => ({
  keyId: "key-me",
  claims: [...claimsForPreset[preset]],
})
test("UI helpers use the same CASL claims", () => {
  expect(actor("editor").claims).toEqual([...claimsForPreset.editor])
})
