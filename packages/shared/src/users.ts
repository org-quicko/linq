import { z } from "zod"
import { roleSchema, userStatusSchema } from "./roles.ts"

export const userCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.email().max(200).nullable().optional(),
  role: roleSchema,
})

export const userPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    email: z.email().max(200).nullable(),
    role: roleSchema,
    status: userStatusSchema,
  })
  .partial()

export const keyCreateSchema = z.object({
  label: z.string().trim().min(1).max(100),
  /** ISO-8601. Absent means the key never expires. */
  expiresAt: z.iso.datetime().nullable().optional(),
})

export type User = {
  id: string
  name: string
  email: string | null
  role: "viewer" | "author" | "editor" | "admin"
  status: "active" | "disabled"
  createdAt: string
  updatedAt: string
}

/** What every authenticated role may see about other users. */
export type UserSummary = { id: string; name: string }

export type ApiKey = {
  id: string
  userId: string
  label: string
  prefix: string
  expiresAt: string | null
  createdAt: string
}

/** The plaintext secret is returned exactly once, at creation. */
export type ApiKeyCreated = ApiKey & { secret: string }
