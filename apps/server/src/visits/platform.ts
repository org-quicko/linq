import type { Browser, Os, Platform } from "@linq/shared"
import { UAParser } from "ua-parser-js"

/** Three checks, in order; anything unrecognised counts as a desktop. */
export function detectPlatform(userAgent: string | null | undefined): Platform {
  if (!userAgent) return "desktop"
  if (/Android/i.test(userAgent)) return "android"
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios"
  return "desktop"
}

/**
 * Lowercased so the same OS never fragments into two rollup buckets by
 * casing alone — ua-parser-js's own casing ("macOS", "Windows") isn't
 * consistent enough to store verbatim.
 */
export function detectOs(userAgent: string | null | undefined): Os | null {
  if (!userAgent) return null
  const name = UAParser(userAgent).os.name
  return name ? name.toLowerCase() : null
}

/** Same lowercasing as `detectOs`, same reason. */
export function detectBrowser(userAgent: string | null | undefined): Browser | null {
  if (!userAgent) return null
  const name = UAParser(userAgent).browser.name
  return name ? name.toLowerCase() : null
}
