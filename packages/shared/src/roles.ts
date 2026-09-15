import { z } from "zod"

/** Ordered least to most privileged. Comparisons rely on this order. */
export const ROLES = ["viewer", "author", "editor", "admin"] as const
export type Role = (typeof ROLES)[number]
export const roleSchema = z.enum(ROLES)

const RANK: Record<Role, number> = { viewer: 0, author: 1, editor: 2, admin: 3 }

/** True when `role` is at least as privileged as `min`. */
export function roleAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min]
}

export const USER_STATUSES = ["active", "disabled"] as const
export type UserStatus = (typeof USER_STATUSES)[number]
export const userStatusSchema = z.enum(USER_STATUSES)

/** Linqs and domains are archived, never deleted. See docs/adr/0002. */
export const RESOURCE_STATUSES = ["active", "archived"] as const
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number]
export const resourceStatusSchema = z.enum(RESOURCE_STATUSES)
