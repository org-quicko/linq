import { z } from "zod"
import { type Role, roleSchema } from "./roles.ts"

export const keyCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  role: roleSchema,
  /** ISO-8601. Absent means the key never expires. */
  expiresAt: z.iso.datetime().nullable().optional(),
})

export const keyPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    role: roleSchema,
    expiresAt: z.iso.datetime().nullable(),
  })
  .partial()

/**
 * The principal. There are no user rows: a key holds its own name and role, and
 * revoking one is a real delete. See docs/adr/0011.
 */
export type ApiKey = {
  id: string
  name: string
  role: Role
  prefix: string
  expiresAt: string | null
  createdAt: string
  updatedAt: string
}

/** What every role below admin may see about another key. */
export type ApiKeySummary = { id: string; name: string }

/** The plaintext secret is returned exactly once, at creation. */
export type ApiKeyCreated = ApiKey & { secret: string }
