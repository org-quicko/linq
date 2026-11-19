import { z } from "zod"
import { claimsSchema, keyPresetSchema } from "./PermissionSchema.ts"

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
