import { findBotMatch, isbot } from "isbot"

/** A request with no User-Agent at all is not a browser, so it counts as a bot. */
export function detectBot(userAgent: string | null | undefined): boolean {
  return !userAgent || isbot(userAgent)
}

/**
 * What isbot's own pattern match actually was — often already recognisable
 * (`"googlebot"`, `"facebookexternalhit"`, `"slackbot"`), sometimes a
 * generic term (`"crawl"`, `"spider"`) for an obscure or unlisted bot.
 * Lowercased so the same bot family never fragments into two buckets by
 * casing alone. Null for a human, and for a bot flagged only by having no
 * User-Agent at all — nothing to match against in that case.
 */
export function detectBotLabel(userAgent: string | null | undefined): string | null {
  return findBotMatch(userAgent)?.toLowerCase() ?? null
}

/**
 * Link-preview crawlers specifically — the ones that read Open Graph tags to
 * render a chat/social card. Distinct from `detectBot`: a monitoring bot or a
 * search crawler is a bot too, but it expects the real redirect, not a
 * preview page, so it is deliberately not included here.
 */
export function isPreviewCrawler(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false
  return /Slackbot|Twitterbot|facebookexternalhit|Facebot|Discordbot|LinkedInBot|TelegramBot|WhatsApp|SkypeUriPreview/i.test(
    userAgent,
  )
}
