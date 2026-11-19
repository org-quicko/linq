import { createMongoAbility } from "@casl/ability"
import { claimsForPreset, PRESETS } from "../constants/index.ts"
import { claimsSchema } from "../schemas/index.ts"
import type { Actor, AppAbility, Claim, KeyPreset } from "../types/index.ts"

/** Permission rules both the API and the Client UI evaluate, through CASL. */
export class PermissionUtil {
  /** Builds the same capability-only CASL ability on the API and in the Client UI. */
  static defineAbility(claims: readonly Claim[]): AppAbility {
    return createMongoAbility<AppAbility>([...claims])
  }

  static claimsEqual(left: readonly Claim[], right: readonly Claim[]): boolean {
    return (
      left.length === right.length &&
      left.every((claim) =>
        right.some((other) => claim.action === other.action && claim.subject === other.subject),
      )
    )
  }

  static presetForClaims(claims: readonly Claim[]): KeyPreset | null {
    return (
      PRESETS.find((preset) => PermissionUtil.claimsEqual(claims, claimsForPreset[preset])) ?? null
    )
  }

  /**
   * The inverse of `presetForClaims`: a request names either a preset or an
   * explicit claim list, and this is the list either way.
   */
  static resolveClaims(input: { preset?: KeyPreset; claims?: unknown }): Claim[] {
    return input.preset ? [...claimsForPreset[input.preset]] : claimsSchema.parse(input.claims)
  }

  /** Compatibility-shaped UI helpers, each evaluated by CASL. */
  static readonly can = {
    createLink: (actor: Actor): boolean =>
      PermissionUtil.defineAbility(actor.claims).can("create", "Link"),
    editLink: (actor: Actor): boolean =>
      PermissionUtil.defineAbility(actor.claims).can("update", "Link"),
    archiveLink: (actor: Actor): boolean =>
      PermissionUtil.defineAbility(actor.claims).can("archive", "Link"),
    purge: (actor: Actor): boolean =>
      PermissionUtil.defineAbility(actor.claims).can("purge", "Link"),
    manageDomains: (actor: Actor): boolean =>
      PermissionUtil.defineAbility(actor.claims).can("create", "Domain"),
    manageKeys: (actor: Actor): boolean =>
      PermissionUtil.defineAbility(actor.claims).can("create", "Key"),
    changeRoleOf: (actor: Actor, targetKeyId: string): boolean =>
      PermissionUtil.defineAbility(actor.claims).can("update", "Key") &&
      actor.keyId !== targetKeyId,
    revokeKey: (actor: Actor, targetKeyId: string): boolean =>
      PermissionUtil.defineAbility(actor.claims).can("delete", "Key") &&
      actor.keyId !== targetKeyId,
  }
}
