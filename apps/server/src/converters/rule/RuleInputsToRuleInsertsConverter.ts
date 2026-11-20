import type { RuleInput, RuleInsert } from "@linq/shared"

/**
 * Maps an ordered rule set to `rules` rows. The server owns `position`: it is
 * each rule's index in the list.
 *
 * @param linkId - The link the rules belong to.
 * @param rules - The validated rules, in match order.
 * @returns One insert row per rule.
 */
export class RuleInputsToRuleInsertsConverter {
  convertFrom(linkId: string, rules: RuleInput[]): RuleInsert[] {
    return rules.map((rule, position) => ({
      id: Bun.randomUUIDv7(),
      link_id: linkId,
      position,
      destination: rule.destination,
      conditions: JSON.stringify(rule.conditions),
    }))
  }
}
