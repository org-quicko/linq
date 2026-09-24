import { isbot } from "isbot"

/** A request with no User-Agent at all is not a browser, so it counts as a bot. */
export function detectBot(user_agent: string | null | undefined): boolean {
  return !user_agent || isbot(user_agent)
}

/**
 * Link-preview crawlers specifically — the ones that read Open Graph tags to
 * render a chat/social card. Distinct from `detectBot`: a monitoring bot or a
 * search crawler is a bot too, but it expects the real redirect, not a
 * preview page, so it is deliberately not included here.
 */
export function isPreviewCrawler(user_agent: string | null | undefined): boolean {
  if (!user_agent) return false
  return /Slackbot|Twitterbot|facebookexternalhit|Facebot|Discordbot|LinkedInBot|TelegramBot|WhatsApp|SkypeUriPreview/i.test(
    user_agent,
  )
}
