import { z } from "zod"
import { claimsSchema, keyPresetSchema, type Claim, type KeyPreset } from "./abilities.ts"

export const keyCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    preset: keyPresetSchema.optional(),
    claims: claimsSchema.optional(),
    expires_at: z.iso.datetime().nullable().optional(),
  })
  .strict()
  .refine(
    (value) => (value.preset === undefined) !== (value.claims === undefined),
    "provide exactly one of preset or claims",
  )

export const keyPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    preset: keyPresetSchema.optional(),
    claims: claimsSchema.optional(),
    expires_at: z.iso.datetime().nullable(),
  })
  .strict()
  .partial()
  .refine(
    (value) => !(value.preset !== undefined && value.claims !== undefined),
    "provide preset or claims, not both",
  )

/** The principal. A key holds claims and is the only credential linq issues. */
export type ApiKey = {
  id: string
  name: string
  claims: Claim[]
  preset: KeyPreset | null
  prefix: string
  expires_at: string | null
  created_at: string
  updated_at: string
}

export type ApiKeySummary = Pick<ApiKey, "id" | "name" | "claims" | "preset">
export type ApiKeyCreated = ApiKey & { secret: string }
