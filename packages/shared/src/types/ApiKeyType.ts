import type { z } from "zod"
import type { keyCreateSchema, keyPatchSchema } from "../schemas/index.ts"
import type { Claim, KeyPreset } from "./PermissionType.ts"

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

/** What a caller that cannot manage keys sees of one. */
export type ApiKeySummary = Pick<ApiKey, "id" | "name" | "claims" | "preset">

/** `POST /keys`'s response: the key plus its secret, shown exactly once. */
export type ApiKeyCreated = ApiKey & { secret: string }

/** A validated `POST /keys` body. */
export type ApiKeyCreateBody = z.infer<typeof keyCreateSchema>

/** A validated `PATCH /keys/:id` body. */
export type ApiKeyPatchBody = z.infer<typeof keyPatchSchema>

/** What the server's `ApiKeyService.create` takes: a name, resolved claims and an expiry. */
export type ApiKeyCreateInput = { name: string; claims: Claim[]; expiresAt: Date | null }

/** What the server's `updateApiKey` takes. A field left undefined is left alone. */
export type ApiKeyPatchInput = { name?: string; claims?: Claim[]; expiresAt?: Date | null }

/** An `api_keys` row as the database returns it. `claims` is unvalidated JSON. */
export type ApiKeyRow = {
  id: string
  name: string
  claims: unknown
  key_hash: string
  prefix: string
  expires_at: Date | null
  created_at: Date
  updated_at: Date
}
