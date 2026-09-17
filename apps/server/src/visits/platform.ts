import type { Platform } from "@linq/shared"

/** Three checks, in order; anything unrecognised counts as a desktop. */
export function detectPlatform(userAgent: string | null | undefined): Platform {
  if (!userAgent) return "desktop"
  if (/Android/i.test(userAgent)) return "android"
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios"
  return "desktop"
}
