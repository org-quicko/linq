import type { z } from "zod"
import type { conditionSchema, ruleInputSchema } from "../schemas/index.ts"
import type { Platform } from "./CommonType.ts"

/** One predicate inside a rule. All conditions of a rule must hold for it to win. */
export type Condition = z.infer<typeof conditionSchema>

/** The kinds of condition a rule can carry. */
export type ConditionType = Condition["type"]

/** One rule as a client writes it. */
export type RuleInput = z.infer<typeof ruleInputSchema>

/** A rule as the API returns it. */
export type Rule = RuleInput & {
  id: string
  link_id: string
  position: number
}

/** A `rules` row as the database returns it. */
export type RuleRow = {
  id: string
  link_id: string
  position: number
  destination: string
  conditions: Condition[]
}

/** One `rules` row to insert; `conditions` is serialised JSON. */
export type RuleInsert = Omit<RuleRow, "conditions"> & { conditions: string }

/** What a request looks like to the rule engine. */
export type MatchContext = {
  platform: Platform
  query: URLSearchParams
}
