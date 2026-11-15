import type { Condition, Platform, Rule, RuleInput } from "@linq/shared"
import type { Selectable } from "kysely"
import type { DB } from "../db/types.generated.ts"
import { type Db, span } from "../libs/index.ts"

/** What a request looks like to the rule engine. Nothing here touches the database. */
export type MatchContext = {
  platform: Platform
  query: URLSearchParams
}

/** Maps a rule row to the JSON shape the API returns. */
export function toRule(row: Selectable<DB["rules"]>): Rule {
  return {
    id: row.id,
    link_id: row.link_id,
    position: row.position,
    destination: row.destination,
    conditions: row.conditions,
  }
}

/**
 * Conditions are ANDed. A rule carrying none can never match: writes reject an
 * empty list, and `[].every()` would otherwise make such a row match everything.
 */
export function ruleMatches(rule: { conditions: Condition[] }, ctx: MatchContext): boolean {
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
 * `rules` must already be in `position` order; `listRules` is what guarantees it.
 */
export function matchRules<T extends { conditions: Condition[]; destination: string }>(
  rules: T[],
  ctx: MatchContext,
): string | null {
  return rules.find((rule) => ruleMatches(rule, ctx))?.destination ?? null
}

/**
 * Reads every rule of one link in `position` order.
 *
 * The ordering is the contract `matchRules` relies on for first-match-wins, so
 * it lives here: the redirect and the API read rules the same way.
 */
export function listRules(db: Db, linkId: string) {
  return span(
    "rules.list",
    () =>
      db
        .selectFrom("rules")
        .selectAll()
        .where("link_id", "=", linkId)
        .orderBy("position")
        .execute(),
    { in: { link_id: linkId }, out: (rows) => ({ count: rows.length }) },
  )
}

/**
 * Replaces a link's whole ordered rule set; the server owns `position`. Run it
 * inside a transaction, so a failed insert can never leave the link with its
 * old rules deleted and no new ones in their place.
 */
export async function replaceRules(db: Db, linkId: string, rules: RuleInput[]): Promise<void> {
  await db.deleteFrom("rules").where("link_id", "=", linkId).execute()
  if (rules.length === 0) return
  await db
    .insertInto("rules")
    .values(
      rules.map((rule, position) => ({
        id: Bun.randomUUIDv7(),
        link_id: linkId,
        position,
        destination: rule.destination,
        conditions: JSON.stringify(rule.conditions),
      })),
    )
    .execute()
}
