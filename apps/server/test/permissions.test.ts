import { describe, expect, test } from "bun:test"
import { type Actor, can, ROLES, type Role } from "@linq/shared"
import type { Principal } from "../src/auth/middleware.ts"
import { assertCanEdit, assertCanTransfer, assertRole } from "../src/auth/permissions.ts"

const principal = (role: Role, userId = "u1"): Principal => ({ role, userId, keyId: "k1" })
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
      viewer: ["viewer", "author", "editor", "admin"],
      author: ["author", "editor", "admin"],
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
  test("editors and admins act on anything", () => {
    expect(allows(() => assertCanEdit(principal("editor"), "someone-else"))).toBe(true)
    expect(allows(() => assertCanEdit(principal("admin"), "someone-else"))).toBe(true)
  })

  test("an author acts only on what it owns", () => {
    expect(allows(() => assertCanEdit(principal("author", "u1"), "u1"))).toBe(true)
    expect(allows(() => assertCanEdit(principal("author", "u1"), "u2"))).toBe(false)
  })

  test("a viewer that owns something still cannot change it", () => {
    expect(allows(() => assertCanEdit(principal("viewer", "u1"), "u1"))).toBe(false)
  })
})

describe("assertCanTransfer", () => {
  test("an editor hands over only its own", () => {
    expect(allows(() => assertCanTransfer(principal("editor", "u1"), "u1"))).toBe(true)
    expect(allows(() => assertCanTransfer(principal("editor", "u1"), "u2"))).toBe(false)
  })

  test("an admin hands over anyone's", () => {
    expect(allows(() => assertCanTransfer(principal("admin", "u1"), "u2"))).toBe(true)
  })
})

/**
 * The shared predicates the wrappers above delegate to, and which the Admin UI
 * reads directly. The matrix is written out rather than derived, so a change to
 * the rules has to be made here too instead of quietly agreeing with itself.
 */
const ME = "user-me"
const OTHER = "user-other"
const actor = (role: Role): Actor => ({ userId: ME, role })
const mine = { ownerId: ME }
const theirs = { ownerId: OTHER }

describe("can", () => {
  test("createLinq needs author or better", () => {
    expect(ROLES.filter((role) => can.createLinq(actor(role)))).toEqual([
      "author",
      "editor",
      "admin",
    ])
  })

  test("editLinq: own from author upwards, anyone else's from editor upwards", () => {
    expect(ROLES.filter((role) => can.editLinq(actor(role), mine))).toEqual([
      "author",
      "editor",
      "admin",
    ])
    expect(ROLES.filter((role) => can.editLinq(actor(role), theirs))).toEqual(["editor", "admin"])
  })

  test("transferLinq: own from author upwards, anyone else's admin only", () => {
    expect(ROLES.filter((role) => can.transferLinq(actor(role), mine))).toEqual([
      "author",
      "editor",
      "admin",
    ])
    expect(ROLES.filter((role) => can.transferLinq(actor(role), theirs))).toEqual(["admin"])
  })

  test("transferLinq never permits what editLinq refuses", () => {
    for (const role of ROLES) {
      for (const linq of [mine, theirs]) {
        if (can.transferLinq(actor(role), linq)) expect(can.editLinq(actor(role), linq)).toBe(true)
      }
    }
  })

  test("domains and users are admin only", () => {
    expect(ROLES.filter((role) => can.manageDomains(actor(role)))).toEqual(["admin"])
    expect(ROLES.filter((role) => can.manageUsers(actor(role)))).toEqual(["admin"])
  })

  test("an admin may not change its own role or disable itself", () => {
    expect(can.changeRoleOf(actor("admin"), ME)).toBe(false)
    expect(can.changeRoleOf(actor("admin"), OTHER)).toBe(true)
    expect(can.disableUser(actor("admin"), ME)).toBe(false)
    expect(can.disableUser(actor("admin"), OTHER)).toBe(true)
  })

  test("a non-admin changes nobody", () => {
    for (const role of ["viewer", "author", "editor"] as const) {
      expect(can.changeRoleOf(actor(role), OTHER)).toBe(false)
      expect(can.disableUser(actor(role), OTHER)).toBe(false)
    }
  })
})
