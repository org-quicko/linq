import { type Role, roleAtLeast } from "./roles.ts"

/** Who is acting: the two fields every rule below is decided from. */
export type Actor = { userId: string; role: Role }

/** Any resource that has an owner. Only `ownerId` is ever read. */
export type Owned = { ownerId: string }

/**
 * Every permission rule in linq, in one place.
 *
 * These are pure predicates so that the server and the Client UI decide the same
 * way: the server wraps them in the 403-throwing helpers in
 * `apps/server/src/auth/permissions.ts`, and the UI uses them to stop offering
 * an action it already knows will be refused.
 *
 * The UI check is a courtesy, never a permission. The server one is the real
 * gate, and it is applied to every request regardless of what the UI showed.
 */
export const can = {
  /** Anyone who may own a link may create one. */
  createLink: (actor: Actor): boolean => roleAtLeast(actor.role, "author"),

  /**
   * Editors and admins act on anything; an author acts on what it owns. A viewer
   * that happens to own a link, through a transfer, still cannot change it.
   */
  editLink: (actor: Actor, link: Owned): boolean =>
    roleAtLeast(actor.role, "editor") ||
    (actor.userId === link.ownerId && roleAtLeast(actor.role, "author")),

  /**
   * Handing a link to someone else. An editor may change any link but hands over
   * only its own; reassigning someone else's link is an admin move.
   *
   * Strictly narrower than `editLink`, which the server checks first.
   */
  transferLink: (actor: Actor, link: Owned): boolean =>
    actor.role === "admin" || (actor.userId === link.ownerId && roleAtLeast(actor.role, "author")),

  /**
   * Destroying an archived Link or Domain for good. Admin only, and deliberately
   * not implied by `manageDomains` or `editLink`: it is irreversible, and for a
   * link it releases the slug that archiving reserves. See docs/adr/0002.
   */
  purge: (actor: Actor): boolean => actor.role === "admin",

  /** Adding, editing and archiving domains. */
  manageDomains: (actor: Actor): boolean => actor.role === "admin",

  /** Reaching the users page at all, and creating or minting on it. */
  manageUsers: (actor: Actor): boolean => actor.role === "admin",

  /** Nobody changes their own role: it is the one-way door out of admin. */
  changeRoleOf: (actor: Actor, targetUserId: string): boolean =>
    actor.role === "admin" && actor.userId !== targetUserId,

  /**
   * Nobody disables themselves. A disabled user's keys all 401 and only an admin
   * can re-enable one, so the last admin would lock the instance out of its own
   * API. The server enforces this too.
   */
  disableUser: (actor: Actor, targetUserId: string): boolean =>
    actor.role === "admin" && actor.userId !== targetUserId,
}
