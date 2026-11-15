import { type Action, ApiError, type Subject } from "@linq/shared"
import type { Principal } from "../libs/index.ts"

/**
 * The server-side boundary: the authenticated request's CASL ability decides
 * every grant. Called inside a handler rather than mounted as middleware, so a
 * route can 404 an unknown resource before it asks the permission question.
 */
export function authorize(principal: Principal, action: Action, subject: Subject): void {
  if (!principal.ability.can(action, subject)) throw ApiError.forbidden()
}
