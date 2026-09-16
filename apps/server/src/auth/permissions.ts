import { ApiError, can, type Role, roleAtLeast } from "@linq/shared"
import type { Principal } from "./middleware.ts"

/**
 * The throwing half of the permission rules. The rules themselves live in
 * `@linq/shared`, so the Client UI decides the same way this does and the two
 * cannot drift.
 */

/** Throws 403 unless the principal holds `min` or a more privileged role. */
export function assertRole(principal: Principal, min: Role): void {
  if (!roleAtLeast(principal.role, min)) throw ApiError.forbidden()
}

/** Throws 403 unless the principal may change this link. See `can.editLink`. */
export function assertCanEdit(principal: Principal, ownerId: string): void {
  if (!can.editLink(principal, { ownerId })) throw ApiError.forbidden()
}

/** Throws 403 unless the principal may purge. See `can.purge`. */
export function assertCanPurge(principal: Principal): void {
  if (!can.purge(principal)) throw ApiError.forbidden("only an admin purges")
}

/** Throws 403 unless the principal may hand this link to someone else. */
export function assertCanTransfer(principal: Principal, ownerId: string): void {
  if (!can.transferLink(principal, { ownerId })) {
    throw ApiError.forbidden("only an admin transfers a link it does not own")
  }
}
