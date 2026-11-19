import type { z } from "zod"
import type { PLATFORMS, RESOURCE_STATUSES } from "../constants/index.ts"
import type { paginationSchema } from "../schemas/index.ts"

export type Platform = (typeof PLATFORMS)[number]

/**
 * Open-ended, unlike `Platform` — ua-parser-js's real vocabulary (dozens of
 * OS/browser names) can't be pinned to a fixed list. Named for signature
 * clarity, not as a closed set.
 */
export type Os = string
export type Browser = string

export type Pagination = z.infer<typeof paginationSchema>

export type Page<T> = {
  data: T[]
  total: number
  limit: number
  offset: number
}

export type ResourceStatus = (typeof RESOURCE_STATUSES)[number]
