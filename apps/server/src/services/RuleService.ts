import type { RuleInput } from "@linq/shared"
import type { Db } from "../clients/index.ts"
import { RuleInputsToRuleInsertsConverter } from "../converters/index.ts"
import { Log } from "../libs/index.ts"

const ruleInputsToRuleInsertsConverter = new RuleInputsToRuleInsertsConverter()

/**
 * Storage for a link's routing rules. Bound to whatever executor it is built
 * with, so a caller already inside a transaction builds one on its `tx`
 * (`new RuleService(tx)`) and the rule writes join that transaction.
 */
export class RuleService {
  /**
   * @param db - The database, or a transaction the rule writes should join.
   */
  constructor(private readonly db: Db) {}

  /**
   * Reads every rule of one link in `position` order. The ordering is the
   * contract `matchRules` relies on for first-match-wins, so it lives here:
   * the redirect and the API read rules the same way.
   *
   * @param linkId - id of the link.
   * @returns The link's rule rows, in `position` order (empty if it has none).
   */
  @Log("rules.list", {
    in: (linkId: string) => ({ link_id: linkId }),
    out: (rows: unknown[]) => ({ count: rows.length }),
  })
  async list(linkId: string) {
    return this.db
      .selectFrom("rules")
      .selectAll()
      .where("link_id", "=", linkId)
      .orderBy("position")
      .execute()
  }

  /**
   * Replaces a link's whole ordered rule set; the server owns `position`.
   * Build this service on a transaction before calling it, so a failed insert
   * can never leave the link with its old rules deleted and no new ones.
   *
   * @param linkId - id of the link.
   * @param rules - The new rule set, in order.
   */
  async replace(linkId: string, rules: RuleInput[]): Promise<void> {
    await this.db.deleteFrom("rules").where("link_id", "=", linkId).execute()
    if (rules.length === 0) return
    await this.db
      .insertInto("rules")
      .values(ruleInputsToRuleInsertsConverter.convertFrom(linkId, rules))
      .execute()
  }
}
