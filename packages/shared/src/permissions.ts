import { type Role, roleAtLeast } from "./roles.ts"

/** Who is acting: the two fields every rule below is decided from. */
export type Actor = { keyId: string; role: Role }

/** Any resource that has an owner. Null means unowned — see docs/adr/0011. */
export type Owned = { owner_id: string | null }

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
  /**
   * Who may hold a link. A viewer may not: `editLink` refuses a viewer even
   * over its own link, so a viewer-owned link would be one nobody but a
   * manager could touch.
   */
  ownLink: (target: { role: Role }): boolean => roleAtLeast(target.role, "author"),

  /** Anyone who may own a link may create one. */
  createLink: (actor: Actor): boolean => can.ownLink(actor),

  /**
   * Managers and admins act on anything; an author acts on what its own key
   * created. A viewer can no longer *acquire* a link by transfer (`ownLink`)
   * or by demotion (the server refuses `PATCH /keys/:id` below the ownership
   * threshold while it still owns links — see `docs/adr/0011`'s amendments),
   * so the only way one still ends up owning a link is a key demoted before
   * either rule shipped — a state this repo tolerates rather than migrates,
   * the same way an unowned link is tolerated. Either way it still cannot
   * change it, and an unowned link matches no actor — `keyId` is never null,
   * so a null owner fails closed here rather than by a special case.
   *
   * Also the rule for a QR code (docs/plans/Plan_31.md): a QR code has no owner of
   * its own, so editing or deleting one is decided by its link's `owner_id`.
   */
  editLink: (actor: Actor, link: Owned): boolean =>
    roleAtLeast(actor.role, "manager") ||
    (actor.keyId === link.owner_id && roleAtLeast(actor.role, "author")),

  /**
   * Handing a link to another key. A manager may change any link but hands over
   * only its own; reassigning someone else's link is an admin move. This is also
   * how a key is rotated: mint, transfer, revoke.
   *
   * Strictly narrower than `editLink`, which the server checks first.
   */
  transferLink: (actor: Actor, link: Owned): boolean =>
    actor.role === "admin" || (actor.keyId === link.owner_id && roleAtLeast(actor.role, "author")),

  /**
   * Destroying an archived Link or Domain for good. Admin only, and deliberately
   * not implied by `manageDomains` or `editLink`: it is irreversible, and for a
   * link it releases the slug that archiving reserves. See docs/adr/0002.
   */
  purge: (actor: Actor): boolean => actor.role === "admin",

  /** Adding, editing and archiving domains. */
  manageDomains: (actor: Actor): boolean => actor.role === "admin",

  /** Reaching the keys page at all, and minting or revoking on it. */
  manageKeys: (actor: Actor): boolean => actor.role === "admin",

  /** Nobody changes their own role: it is the one-way door out of admin. */
  changeRoleOf: (actor: Actor, targetKeyId: string): boolean =>
    actor.role === "admin" && actor.keyId !== targetKeyId,

  /**
   * Nobody revokes the key they are calling with. Revocation is a real delete
   * and there is no re-enabling, so the last admin would lock the instance out
   * of its own API with only the CLI left as a way back. The server enforces
   * this too.
   */
  revokeKey: (actor: Actor, targetKeyId: string): boolean =>
    actor.role === "admin" && actor.keyId !== targetKeyId,
}
