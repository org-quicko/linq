import { describe, expect, test } from "bun:test"
import { type Actor, can, ROLES, type Role } from "@linq/shared"
import type { Principal } from "../src/auth/middleware.ts"
import { assertCanArchive, assertCanEdit, assertRole } from "../src/auth/permissions.ts"

const principal = (role: Role, keyId = "k1"): Principal => ({ role, keyId, name: "test" })
/** True when `fn` does not throw, so a permission matrix reads as booleans. */
const allows = (fn: () => void) => {
  try {
    fn()
    return true
  } catch {
    return false
  }
}

describe("assertRole", () => {
  test("admits exactly the roles at or above the minimum", () => {
    const matrix: Record<Role, Role[]> = {
      viewer: ["viewer", "editor", "admin"],
      editor: ["editor", "admin"],
      admin: ["admin"],
    }
    for (const min of ROLES) {
      for (const role of ROLES) {
        expect(allows(() => assertRole(principal(role), min))).toBe(matrix[min].includes(role))
      }
    }
  })
})

describe("assertCanEdit", () => {
  test("an editor or admin may create and edit any link", () => {
    expect(allows(() => assertCanEdit(principal("editor")))).toBe(true)
    expect(allows(() => assertCanEdit(principal("admin")))).toBe(true)
  })

  test("a viewer may not", () => {
    expect(allows(() => assertCanEdit(principal("viewer")))).toBe(false)
  })
})

describe("assertCanArchive", () => {
  test("admin only", () => {
    expect(allows(() => assertCanArchive(principal("admin")))).toBe(true)
    expect(allows(() => assertCanArchive(principal("editor")))).toBe(false)
    expect(allows(() => assertCanArchive(principal("viewer")))).toBe(false)
  })
})

/**
 * The shared predicates the wrappers above delegate to, and which the Client UI
 * reads directly. The matrix is written out rather than derived, so a change to
 * the rules has to be made here too instead of quietly agreeing with itself.
 */
const ME = "key-me"
const OTHER = "key-other"
const actor = (role: Role): Actor => ({ keyId: ME, role })

describe("can", () => {
  test("createLink and editLink need editor or better", () => {
    expect(ROLES.filter((role) => can.createLink(actor(role)))).toEqual(["editor", "admin"])
    expect(ROLES.filter((role) => can.editLink(actor(role)))).toEqual(["editor", "admin"])
  })

  test("archiveLink is admin only, strictly narrower than editLink", () => {
    expect(ROLES.filter((role) => can.archiveLink(actor(role)))).toEqual(["admin"])
    for (const role of ROLES) {
      if (can.archiveLink(actor(role))) expect(can.editLink(actor(role))).toBe(true)
    }
  })

  test("domains and keys are admin only", () => {
    expect(ROLES.filter((role) => can.manageDomains(actor(role)))).toEqual(["admin"])
    expect(ROLES.filter((role) => can.manageKeys(actor(role)))).toEqual(["admin"])
  })

  test("an admin may not change the role of, or revoke, the key it is using", () => {
    expect(can.changeRoleOf(actor("admin"), ME)).toBe(false)
    expect(can.changeRoleOf(actor("admin"), OTHER)).toBe(true)
    expect(can.revokeKey(actor("admin"), ME)).toBe(false)
    expect(can.revokeKey(actor("admin"), OTHER)).toBe(true)
  })

  test("a non-admin changes nobody", () => {
    for (const role of ["viewer", "editor"] as const) {
      expect(can.changeRoleOf(actor(role), OTHER)).toBe(false)
      expect(can.revokeKey(actor(role), OTHER)).toBe(false)
    }
  })
})
