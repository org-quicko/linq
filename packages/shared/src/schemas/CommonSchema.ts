import { z } from "zod"
import { PLATFORMS, RESERVED_SLUGS, RESOURCE_STATUSES, SLUG_PATTERN } from "../constants/index.ts"

export const platformSchema = z.enum(PLATFORMS)

export const uuidSchema = z.uuid()

export const slugSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/^\/+|\/+$/g, ""))
  .pipe(
    z
      .string()
      .regex(SLUG_PATTERN, "slug must be 1-64 characters of A-Z a-z 0-9 _ -")
      .refine((s) => !RESERVED_SLUGS.has(s.toLowerCase()), "slug is reserved"),
  )

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

/** A comma-separated query parameter, as a list. A caller passing one
 *  value keeps working unchanged, which is why these never get plural
 *  names. Absent means an empty list, i.e. no predicate. */
export function csvList<T extends z.ZodType>(item: T) {
  return z.preprocess((v) => {
    if (typeof v !== "string") return []
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  }, z.array(item))
}

export const resourceStatusSchema = z.enum(RESOURCE_STATUSES)
