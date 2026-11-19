import type { Condition, MatchContext } from "@linq/shared"

/** The rule engine: which of a link's routing rules a request matches. */
export class RuleMatchUtil {
  /**
   * Conditions are ANDed. A rule carrying none can never match: writes reject an
   * empty list, and `[].every()` would otherwise make such a row match everything.
   *
   * @param rule - The rule's conditions.
   * @param ctx - The request being redirected.
   * @returns Whether every condition holds.
   */
  static ruleMatches(rule: { conditions: Condition[] }, ctx: MatchContext): boolean {
    return (
      rule.conditions.length > 0 &&
      rule.conditions.every((condition) =>
        condition.type === "platform"
          ? ctx.platform === condition.value
          : // A query_param with no value means "present with any value", including an empty one.
            condition.value === undefined
            ? ctx.query.has(condition.key)
            : ctx.query.getAll(condition.key).includes(condition.value),
      )
    )
  }

  /**
   * The destination of the first matching rule, or null to use the link's default.
   * `rules` must already be in `position` order; `RuleService.list` is what guarantees it.
   *
   * @param rules - The link's rules, in `position` order.
   * @param ctx - The request being redirected.
   * @returns The winning destination, or null.
   */
  static matchRules<T extends { conditions: Condition[]; destination: string }>(
    rules: T[],
    ctx: MatchContext,
  ): string | null {
    return rules.find((rule) => RuleMatchUtil.ruleMatches(rule, ctx))?.destination ?? null
  }
}
