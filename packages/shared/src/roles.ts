import { z } from "zod"

/** Ordered least to most privileged. Comparisons rely on this order. */
export const ROLES = ["viewer", "author", "manager", "admin"] as const
export type Role = (typeof ROLES)[number]
export const roleSchema = z.enum(ROLES)

/**
 * True when `role` is at least as privileged as `min`.
 *
 * Position in `ROLES` is the rank, so the order is stated once. A value outside
 * the tuple scores -1 and compares as less privileged than every real role,
 * which fails closed — though `roleSchema` guards the boundary in any case.
 */
export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(min)
}

export const USER_STATUSES = ["active", "disabled"] as const
export type UserStatus = (typeof USER_STATUSES)[number]
export const userStatusSchema = z.enum(USER_STATUSES)

/** Links and domains are archived, never deleted. See docs/adr/0002. */
export const RESOURCE_STATUSES = ["active", "archived"] as const
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number]
export const resourceStatusSchema = z.enum(RESOURCE_STATUSES)
