import { describe, expect, test } from "bun:test"
import { type Actor, can, ROLES, type Role } from "@linq/shared"
import type { Principal } from "../src/auth/middleware.ts"
import { assertCanEdit, assertCanTransfer, assertRole } from "../src/auth/permissions.ts"

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
      viewer: ["viewer", "author", "manager", "admin"],
      author: ["author", "manager", "admin"],
      manager: ["manager", "admin"],
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
  test("managers and admins act on anything", () => {
    expect(allows(() => assertCanEdit(principal("manager"), "someone-else"))).toBe(true)
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
  test("an manager hands over only its own", () => {
    expect(allows(() => assertCanTransfer(principal("manager", "u1"), "u1"))).toBe(true)
    expect(allows(() => assertCanTransfer(principal("manager", "u1"), "u2"))).toBe(false)
  })

  test("an admin hands over anyone's", () => {
    expect(allows(() => assertCanTransfer(principal("admin", "u1"), "u2"))).toBe(true)
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
const mine = { ownerId: ME }
const theirs = { ownerId: OTHER }

describe("can", () => {
  test("ownLink needs author or better", () => {
    expect(ROLES.filter((role) => can.ownLink({ role }))).toEqual(["author", "manager", "admin"])
  })

  test("createLink is exactly ownLink", () => {
    for (const role of ROLES) expect(can.createLink(actor(role))).toBe(can.ownLink({ role }))
  })

  test("editLink: own from author upwards, anyone else's from manager upwards", () => {
    expect(ROLES.filter((role) => can.editLink(actor(role), mine))).toEqual([
      "author",
      "manager",
      "admin",
    ])
    expect(ROLES.filter((role) => can.editLink(actor(role), theirs))).toEqual(["manager", "admin"])
  })

  test("transferLink: own from author upwards, anyone else's admin only", () => {
    expect(ROLES.filter((role) => can.transferLink(actor(role), mine))).toEqual([
      "author",
      "manager",
      "admin",
    ])
    expect(ROLES.filter((role) => can.transferLink(actor(role), theirs))).toEqual(["admin"])
  })

  test("transferLink never permits what editLink refuses", () => {
    for (const role of ROLES) {
      for (const link of [mine, theirs]) {
        if (can.transferLink(actor(role), link)) expect(can.editLink(actor(role), link)).toBe(true)
      }
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
    for (const role of ["viewer", "author", "manager"] as const) {
      expect(can.changeRoleOf(actor(role), OTHER)).toBe(false)
      expect(can.revokeKey(actor(role), OTHER)).toBe(false)
    }
  })
})
