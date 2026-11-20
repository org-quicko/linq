import type { Rule, RuleRow } from "@linq/shared"

/**
 * Maps a rule row to the JSON shape the API returns.
 *
 * @param row - A `rules` row.
 * @returns The API `Rule`.
 */
export class RuleRowToRuleConverter {
  convertFrom(row: RuleRow): Rule {
    return {
      id: row.id,
      link_id: row.link_id,
      position: row.position,
      destination: row.destination,
      conditions: row.conditions,
    }
  }
}
