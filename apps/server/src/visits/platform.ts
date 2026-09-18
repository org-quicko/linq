import type { Platform } from "@linq/shared"

/** Three checks, in order; anything unrecognised counts as a desktop. */
export function detectPlatform(userAgent: string | null | undefined): Platform {
  if (!userAgent) return "desktop"
  if (/Android/i.test(userAgent)) return "android"
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios"
  return "desktop"
}

/** Six checks, in order; anything unrecognised is null rather than a guess. */
export function detectOs(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null
  if (/Android/i.test(userAgent)) return "android"
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios"
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "macos"
  if (/Windows/i.test(userAgent)) return "windows"
  if (/CrOS/i.test(userAgent)) return "chromeos"
  if (/Linux/i.test(userAgent)) return "linux"
  return null
}

/** Edge/Opera/Samsung Internet all contain "Chrome" and "Safari" tokens too, so they're peeled off first. */
export function detectBrowser(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null
  if (/Edg\//i.test(userAgent)) return "edge"
  if (/OPR\/|Opera/i.test(userAgent)) return "opera"
  if (/SamsungBrowser/i.test(userAgent)) return "samsung-internet"
  if (/Firefox/i.test(userAgent)) return "firefox"
  if (/Chrome\//i.test(userAgent)) return "chrome"
  if (/Safari/i.test(userAgent)) return "safari"
  if (/MSIE|Trident/i.test(userAgent)) return "ie"
  return null
}
