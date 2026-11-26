import type { LinkRow, ResolvedLinkTree, ResolvedTarget, RuleRow } from "@linq/shared"

/**
 * Folds a link row with its rules, or a Link Tree with its page, into the one
 * entry a cache hit answers the whole request from.
 *
 * @param row - The active link's row.
 * @param rules - The link's rules, in evaluation order; empty for a Link Tree.
 * @param tree - The page a Link Tree serves; omitted for a redirect Link.
 * @returns The cacheable `ResolvedTarget`.
 */
export class LinkRowToResolvedTargetConverter {
  convertFrom(row: LinkRow, rules: RuleRow[], tree?: ResolvedLinkTree): ResolvedTarget {
    return {
      link_id: row.id,
      type: row.type,
      name: row.name,
      destination: row.destination,
      forward_query_params: row.forward_query_params,
      preset_params: row.preset_params,
      rules: rules.map((rule) => ({ destination: rule.destination, conditions: rule.conditions })),
      expires_at: row.expires_at?.getTime() ?? null,
      ...(tree ? { tree } : {}),
    }
  }
}
