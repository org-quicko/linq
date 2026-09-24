import { defineAbility, type Claim } from "./abilities.ts"

/** Who is acting. The server authenticates this key; the UI only mirrors it. */
export type Actor = { keyId: string; claims: Claim[] }

/** Compatibility-shaped UI helpers, each evaluated by CASL. */
export const can = {
  createLink: (actor: Actor): boolean => defineAbility(actor.claims).can("create", "Link"),
  editLink: (actor: Actor): boolean => defineAbility(actor.claims).can("update", "Link"),
  archiveLink: (actor: Actor): boolean => defineAbility(actor.claims).can("archive", "Link"),
  purge: (actor: Actor): boolean => defineAbility(actor.claims).can("purge", "Link"),
  manageDomains: (actor: Actor): boolean => defineAbility(actor.claims).can("create", "Domain"),
  manageKeys: (actor: Actor): boolean => defineAbility(actor.claims).can("create", "Key"),
  changeRoleOf: (actor: Actor, targetKeyId: string): boolean =>
    defineAbility(actor.claims).can("update", "Key") && actor.keyId !== targetKeyId,
  revokeKey: (actor: Actor, targetKeyId: string): boolean =>
    defineAbility(actor.claims).can("delete", "Key") && actor.keyId !== targetKeyId,
}
