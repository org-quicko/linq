/** How a newer visit was classified. `unknown` is not proof of a human. Null predates the field. */
export const BOT_CLASSIFICATION_REASONS = [
  "missing_user_agent",
  "isbot_match",
  "pattern_match",
  "unknown",
] as const
