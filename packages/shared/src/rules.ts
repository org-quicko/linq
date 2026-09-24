import { z } from "zod"
import { platformSchema, urlSchema } from "./primitives.ts"

/**
 * A condition is one predicate inside a Rule. All conditions of a Rule must
 * hold for that Rule to win.
 */
export const conditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("platform"), value: platformSchema }),
  z.object({
    type: z.literal("query_param"),
    key: z.string().trim().min(1).max(64),
    /** Absent means "the parameter is present with any value". */
    value: z.string().max(512).optional(),
  }),
])
export type Condition = z.infer<typeof conditionSchema>
export type ConditionType = Condition["type"]

/** A rule with no conditions can never match, so it is rejected on write. */
export const ruleInputSchema = z.object({
  destination: urlSchema,
  conditions: z.array(conditionSchema).min(1, "a rule needs at least one condition").max(10),
})
export type RuleInput = z.infer<typeof ruleInputSchema>

export const rulesPutSchema = z.array(ruleInputSchema).max(50)

export type Rule = RuleInput & {
  id: string
  link_id: string
  position: number
}
