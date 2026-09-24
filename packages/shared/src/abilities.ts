import { createMongoAbility, type MongoAbility } from "@casl/ability"
import { z } from "zod"

/** Concrete operations only: CASL's `manage` and `all` wildcards are never persisted. */
export const ACTIONS = [
  "read",
  "create",
  "update",
  "archive",
  "restore",
  "purge",
  "delete",
] as const
export type Action = (typeof ACTIONS)[number]
export const actionSchema = z.enum(ACTIONS)

export const SUBJECTS = ["Link", "Rule", "QrCode", "Domain", "Key", "Analytics", "Visit"] as const
export type Subject = (typeof SUBJECTS)[number]
export const subjectSchema = z.enum(SUBJECTS)

/** A deliberately restricted, serializable CASL rule. */
export const claimSchema = z.object({ action: actionSchema, subject: subjectSchema }).strict()
export type Claim = z.infer<typeof claimSchema>
export const claimsSchema = z.array(claimSchema).superRefine((claims, ctx) => {
  const seen = new Set<string>()
  for (const [index, claim] of claims.entries()) {
    const key = `${claim.action}:${claim.subject}`
    if (seen.has(key)) ctx.addIssue({ code: "custom", path: [index], message: "duplicate claim" })
    seen.add(key)
  }
})

export type AppAbility = MongoAbility<[Action, Subject]>

/** Builds the same capability-only CASL ability on the API and in the Client UI. */
export function defineAbility(claims: readonly Claim[]): AppAbility {
  return createMongoAbility<AppAbility>([...claims])
}

export const PRESETS = ["viewer", "editor", "admin"] as const
export type KeyPreset = (typeof PRESETS)[number]
export const keyPresetSchema = z.enum(PRESETS)

const readAll: Claim[] = SUBJECTS.map((subject) => ({ action: "read", subject }))
const editor: Claim[] = [
  ...readAll,
  { action: "create", subject: "Link" },
  { action: "update", subject: "Link" },
  { action: "create", subject: "Rule" },
  { action: "update", subject: "Rule" },
  { action: "create", subject: "QrCode" },
  { action: "update", subject: "QrCode" },
  { action: "delete", subject: "QrCode" },
]

/** Presets are conveniences only; keys persist their expanded claim list. */
export const claimsForPreset: Record<KeyPreset, readonly Claim[]> = {
  viewer: readAll,
  editor,
  admin: [
    ...editor,
    { action: "archive", subject: "Link" },
    { action: "restore", subject: "Link" },
    { action: "purge", subject: "Link" },
    { action: "create", subject: "Domain" },
    { action: "update", subject: "Domain" },
    { action: "archive", subject: "Domain" },
    { action: "purge", subject: "Domain" },
    { action: "create", subject: "Key" },
    { action: "update", subject: "Key" },
    { action: "delete", subject: "Key" },
  ],
}

export function claimsEqual(left: readonly Claim[], right: readonly Claim[]): boolean {
  return (
    left.length === right.length &&
    left.every((claim) =>
      right.some((other) => claim.action === other.action && claim.subject === other.subject),
    )
  )
}

export function presetForClaims(claims: readonly Claim[]): KeyPreset | null {
  return PRESETS.find((preset) => claimsEqual(claims, claimsForPreset[preset])) ?? null
}
