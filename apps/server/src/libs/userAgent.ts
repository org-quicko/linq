import type { BotClassificationReason, Browser, Os, Platform } from "@linq/shared"
import { isbot } from "isbot"
import { UAParser } from "ua-parser-js"

/**
 * Product-specific crawler signatures belong here. Leave this empty until a
 * reviewed, uniquely identifying signature is available: broad matches can
 * misclassify real browsers and app webviews.
 */
const supplementalBotPatterns: readonly RegExp[] = []

/**
 * Classify once at ingest; `is_bot` preserves the existing analytics split. A
 * request with no User-Agent at all is not a browser, so it counts as a bot.
 * The field names are the `visits` columns this is spread into.
 */
export function classifyBot(userAgent: string | null | undefined): {
  is_bot: boolean
  bot_classification_reason: BotClassificationReason
} {
  if (!userAgent) return { is_bot: true, bot_classification_reason: "missing_user_agent" }
  if (isbot(userAgent)) return { is_bot: true, bot_classification_reason: "isbot_match" }
  if (supplementalBotPatterns.some((pattern) => pattern.test(userAgent)))
    return { is_bot: true, bot_classification_reason: "pattern_match" }
  return { is_bot: false, bot_classification_reason: "unknown" }
}

/**
 * Link-preview crawlers specifically — the ones that read Open Graph tags to
 * render a chat/social card. Distinct from `classifyBot`: a monitoring bot or a
 * search crawler is a bot too, but it expects the real redirect, not a
 * preview page, so it is deliberately not included here.
 */
export function isPreviewCrawler(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false
  return /Slackbot|Twitterbot|facebookexternalhit|Facebot|Discordbot|LinkedInBot|TelegramBot|WhatsApp|SkypeUriPreview/i.test(
    userAgent,
  )
}

/** Three checks, in order; anything unrecognised counts as a desktop. */
export function detectPlatform(userAgent: string | null | undefined): Platform {
  if (!userAgent) return "desktop"
  if (/Android/i.test(userAgent)) return "android"
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios"
  return "desktop"
}

/**
 * The OS and browser names, from one parse. Lowercased so the same OS never
 * fragments into two rollup buckets by casing alone — ua-parser-js's own casing
 * ("macOS", "Windows") isn't consistent enough to store verbatim.
 */
export function detectOsAndBrowser(userAgent: string | null | undefined): {
  os: Os | null
  browser: Browser | null
} {
  if (!userAgent) return { os: null, browser: null }
  const { os, browser } = UAParser(userAgent)
  return {
    os: os.name ? os.name.toLowerCase() : null,
    browser: browser.name ? browser.name.toLowerCase() : null,
  }
}
