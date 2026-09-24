import type { Browser, Os, Platform } from "@linq/shared"
import { UAParser } from "ua-parser-js"

/** Three checks, in order; anything unrecognised counts as a desktop. */
export function detectPlatform(user_agent: string | null | undefined): Platform {
  if (!user_agent) return "desktop"
  if (/Android/i.test(user_agent)) return "android"
  if (/iPhone|iPad|iPod/i.test(user_agent)) return "ios"
  return "desktop"
}

/**
 * Lowercased so the same OS never fragments into two rollup buckets by
 * casing alone — ua-parser-js's own casing ("macOS", "Windows") isn't
 * consistent enough to store verbatim.
 */
export function detectOs(user_agent: string | null | undefined): Os | null {
  if (!user_agent) return null
  const name = UAParser(user_agent).os.name
  return name ? name.toLowerCase() : null
}

/** Same lowercasing as `detectOs`, same reason. */
export function detectBrowser(user_agent: string | null | undefined): Browser | null {
  if (!user_agent) return null
  const name = UAParser(user_agent).browser.name
  return name ? name.toLowerCase() : null
}
