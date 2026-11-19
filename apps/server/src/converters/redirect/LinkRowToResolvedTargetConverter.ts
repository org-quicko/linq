import type { LinkRow, ResolvedTarget, RuleRow } from "@linq/shared"

/**
 * Folds a link row and its rules into the one entry a cache hit answers the
 * whole redirect from.
 *
 * @param row - The active link's row.
 * @param rules - The link's rules, in evaluation order.
 * @returns The cacheable `ResolvedTarget`.
 */
export class LinkRowToResolvedTargetConverter {
  convertFrom(row: LinkRow, rules: RuleRow[]): ResolvedTarget {
    return {
      link_id: row.id,
      name: row.name,
      destination: row.destination,
      forward_query: row.forward_query,
      preset_params: row.preset_params,
      rules: rules.map((rule) => ({ destination: rule.destination, conditions: rule.conditions })),
      expires_at: row.expires_at?.getTime() ?? null,
    }
  }
}
