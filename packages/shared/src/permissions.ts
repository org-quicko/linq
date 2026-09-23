import { type Role, roleAtLeast } from "./roles.ts"

/** Who is acting: the two fields every rule below is decided from. */
export type Actor = { keyId: string; role: Role }

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
  /** Creating or editing (PATCH) a link, or its rules or QR codes. Not
   *  archiving or restoring one — see `archiveLink`. Links have no owner
   *  (docs/adr/0016), so this is a pure function of role. */
  createLink: (actor: Actor): boolean => roleAtLeast(actor.role, "editor"),
  editLink: (actor: Actor): boolean => roleAtLeast(actor.role, "editor"),

  /**
   * Archiving (`DELETE /links/:id`) or restoring (`PATCH` with `status`) a
   * link. Deliberately narrower than `editLink`: admin only. See
   * docs/adr/0016.
   */
  archiveLink: (actor: Actor): boolean => actor.role === "admin",

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
