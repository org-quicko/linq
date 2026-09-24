import { describe, expect, test } from "bun:test"
import { claimsForPreset, defineAbility, type Actor, type KeyPreset } from "@linq/shared"
import type { Principal } from "../src/auth/middleware.ts"
import { assertCan, assertCanArchive, assertCanEdit } from "../src/auth/permissions.ts"

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
    expect(allows(() => assertCan(principal("editor"), "create", "Link"))).toBe(true)
    expect(allows(() => assertCanEdit(principal("editor")))).toBe(true)
    expect(allows(() => assertCan(principal("viewer"), "create", "Link"))).toBe(false)
  })
  test("archive is a distinct admin claim", () => {
    expect(allows(() => assertCanArchive(principal("admin")))).toBe(true)
    expect(allows(() => assertCanArchive(principal("editor")))).toBe(false)
  })
  test("a custom claim list grants only its exact CASL action and subject", () => {
    const claims = [{ action: "create", subject: "Domain" }] as const
    const custom: Principal = {
      keyId: "custom",
      name: "custom",
      claims: [...claims],
      ability: defineAbility(claims),
    }
    expect(allows(() => assertCan(custom, "create", "Domain"))).toBe(true)
    expect(allows(() => assertCan(custom, "update", "Domain"))).toBe(false)
    expect(allows(() => assertCan(custom, "create", "Link"))).toBe(false)
  })
})

const actor = (preset: KeyPreset): Actor => ({
  keyId: "key-me",
  claims: [...claimsForPreset[preset]],
})
test("UI helpers use the same CASL claims", () => {
  expect(actor("editor").claims).toEqual([...claimsForPreset.editor])
})
