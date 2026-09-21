import { z } from "zod"
import { uuidSchema } from "./primitives.ts"
import { type Role, roleSchema } from "./roles.ts"

export const keyCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  role: roleSchema,
  /** ISO-8601. Absent means the key never expires. */
  expires_at: z.iso.datetime().nullable().optional(),
})

export const keyPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    role: roleSchema,
    expires_at: z.iso.datetime().nullable(),
  })
  .partial()

/** `POST /keys/:id/links/reassign`. Null means unassign, mirroring a link's own `owner_id: null`. */
export const keyLinksReassignSchema = z.object({
  to: uuidSchema.nullable(),
})

/**
 * The principal. There are no user rows: a key holds its own name and role, and
 * revoking one is a real delete. See docs/adr/0011.
 */
export type ApiKey = {
  id: string
  name: string
  role: Role
  prefix: string
  expires_at: string | null
  created_at: string
  updated_at: string
}

/**
 * What every role below admin may see about another key. `role` is included
 * so the UI can filter transfer targets with the same `can.ownLink` predicate
 * the server enforces, rather than offering one it will refuse.
 */
export type ApiKeySummary = { id: string; name: string; role: Role }

/** The plaintext secret is returned exactly once, at creation. */
export type ApiKeyCreated = ApiKey & { secret: string }
