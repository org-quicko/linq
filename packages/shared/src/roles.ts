import { z } from "zod"

/** Links and domains are archived, never deleted. See docs/adr/0002. */
export const RESOURCE_STATUSES = ["active", "archived"] as const
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number]
export const resourceStatusSchema = z.enum(RESOURCE_STATUSES)
