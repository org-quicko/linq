import type { Claim, KeyPreset } from "../types/index.ts"

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

export const SUBJECTS = ["Link", "Rule", "QrCode", "Domain", "Key", "Analytics", "Visit"] as const

export const PRESETS = ["viewer", "editor", "admin"] as const

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
