import type { Condition, Platform, Rule } from "@linq/shared"

/** What a request looks like to the rule engine. Nothing here touches the database. */
export type MatchContext = {
  platform: Platform
  query: URLSearchParams
}

/** Evaluates a single condition against the request. */
function holds(condition: Condition, ctx: MatchContext): boolean {
  switch (condition.type) {
    case "platform":
      return ctx.platform === condition.value
    case "query_param":
      // No value means "present with any value", including an empty one.
      return condition.value === undefined
        ? ctx.query.has(condition.key)
        : ctx.query.getAll(condition.key).includes(condition.value)
  }
}

/**
 * Conditions are ANDed. A rule carrying none can never match: writes reject an
 * empty list, and `[].every()` would otherwise make such a row match everything.
 */
export function ruleMatches(rule: Pick<Rule, "conditions">, ctx: MatchContext): boolean {
  return rule.conditions.length > 0 && rule.conditions.every((c) => holds(c, ctx))
}

/**
 * The destination of the first matching rule, or null to use the link's default.
 * `rules` must already be in `position` order; `listRules` is what guarantees it.
 */
export function matchRules<T extends Pick<Rule, "conditions" | "destination">>(
  rules: T[],
  ctx: MatchContext,
): string | null {
  return rules.find((rule) => ruleMatches(rule, ctx))?.destination ?? null
}
