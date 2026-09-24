import { ApiError, type Action, type Subject } from "@linq/shared"
import type { Principal } from "./middleware.ts"

/** The server-side boundary: the authenticated request's CASL ability decides every grant. */
export function assertCan(principal: Principal, action: Action, subject: Subject): void {
  if (!principal.ability.can(action, subject)) throw ApiError.forbidden()
}

export function assertCanEdit(principal: Principal): void {
  assertCan(principal, "update", "Link")
}
export function assertCanArchive(principal: Principal): void {
  assertCan(principal, "archive", "Link")
}
export function assertCanPurge(principal: Principal): void {
  assertCan(principal, "purge", "Link")
}
