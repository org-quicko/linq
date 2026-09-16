import { z } from "zod"

export const PLATFORMS = ["android", "ios", "desktop"] as const
export type Platform = (typeof PLATFORMS)[number]
export const platformSchema = z.enum(PLATFORMS)

export const uuidSchema = z.uuid()

/** Paths linq answers itself; they can never be slugs. */
export const RESERVED_SLUGS = new Set(["api", "home", "health", "robots.txt", "favicon.ico"])

export const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export const slugSchema = z
  .string()
  .trim()
  .regex(SLUG_PATTERN, "slug must be 1-64 characters of A-Z a-z 0-9 _ -")
  .refine((s) => !RESERVED_SLUGS.has(s.toLowerCase()), "slug is reserved")

/** Absolute http(s) URL, capped to the column width. */
export const urlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value)
      return url.protocol === "http:" || url.protocol === "https:"
    } catch {
      return false
    }
  }, "must be an absolute http(s) URL")

export const tagSchema = z.string().trim().min(1).max(50).toLowerCase()

export const hostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+(:\d{1,5})?$/, "must be a hostname, optionally with a port")

/** Shared list envelope: `{ data, total, limit, offset }`. */
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})
export type Pagination = z.infer<typeof paginationSchema>

export type Page<T> = {
  data: T[]
  total: number
  limit: number
  offset: number
}
