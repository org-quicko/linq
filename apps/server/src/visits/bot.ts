import type { BotClassification } from "@linq/shared"
import { isbot } from "isbot"

export type BotDetection = {
  is_bot: boolean
  bot_classification: BotClassification
}

/**
 * Product-specific crawler signatures belong here. Leave this empty until a
 * reviewed, uniquely identifying signature is available: broad matches can
 * misclassify real browsers and app webviews.
 */
const supplementalBotPatterns: readonly RegExp[] = []

/** Classify once at ingest; `is_bot` preserves the existing analytics split. */
export function classifyBot(user_agent: string | null | undefined): BotDetection {
  if (!user_agent) return { is_bot: true, bot_classification: "missing_user_agent" }
  if (isbot(user_agent)) return { is_bot: true, bot_classification: "isbot_match" }
  if (supplementalBotPatterns.some((pattern) => pattern.test(user_agent)))
    return { is_bot: true, bot_classification: "pattern_match" }
  return { is_bot: false, bot_classification: "unknown" }
}

/** A request with no User-Agent at all is not a browser, so it counts as a bot. */
export function detectBot(user_agent: string | null | undefined): boolean {
  return classifyBot(user_agent).is_bot
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
