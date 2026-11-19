import { z } from "zod"
import { ACTIONS, PRESETS, SUBJECTS } from "../constants/index.ts"

export const actionSchema = z.enum(ACTIONS)

export const subjectSchema = z.enum(SUBJECTS)

/** A deliberately restricted, serializable CASL rule. */
export const claimSchema = z.object({ action: actionSchema, subject: subjectSchema }).strict()
export const claimsSchema = z.array(claimSchema).superRefine((claims, ctx) => {
  const seen = new Set<string>()
  for (const [index, claim] of claims.entries()) {
    const key = `${claim.action}:${claim.subject}`
    if (seen.has(key)) ctx.addIssue({ code: "custom", path: [index], message: "duplicate claim" })
    seen.add(key)
  }
})

export const keyPresetSchema = z.enum(PRESETS)
