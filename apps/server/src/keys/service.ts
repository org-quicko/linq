import {
  ApiError,
  claimsForPreset,
  claimsSchema,
  presetForClaims,
  type ApiKey,
  type ApiKeyCreated,
  type ApiKeySummary,
  type keyCreateSchema,
  type keyPatchSchema,
  type Page,
  type Pagination,
} from "@linq/shared"
import type { Selectable } from "kysely"
import type { z } from "zod"
import type { Principal } from "../auth/middleware.ts"
import { createApiKey } from "../auth/mint.ts"
import { assertCan } from "../auth/permissions.ts"
import type { DB } from "../db/types.generated.ts"
import type { Deps } from "../deps.ts"

type KeyCreate = z.infer<typeof keyCreateSchema>
type KeyPatch = z.infer<typeof keyPatchSchema>

const resolvedClaims = (value: { preset?: keyof typeof claimsForPreset; claims?: unknown }) =>
  value.preset ? [...claimsForPreset[value.preset]] : claimsSchema.parse(value.claims)

function toApiKey(row: Selectable<DB["api_keys"]>): ApiKey {
  const claims = claimsSchema.parse(row.claims)
  return {
    id: row.id,
    name: row.name,
    claims,
    preset: presetForClaims(claims),
    prefix: row.prefix,
    expires_at: row.expires_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

export async function listKeys(
  { db }: Deps,
  principal: Principal,
  { limit, offset }: Pagination,
): Promise<Page<ApiKey | ApiKeySummary>> {
  assertCan(principal, "read", "Key")
  const rows = await db
    .selectFrom("api_keys")
    .selectAll()
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(limit)
    .offset(offset)
    .execute()
  const total = await db.selectFrom("api_keys").select((eb) => eb.fn.countAll<number>().as("value")).executeTakeFirst()
  const canManage = principal.ability.can("create", "Key")
  const data: (ApiKey | ApiKeySummary)[] = rows.map((row) => {
    const key = toApiKey(row)
    return canManage
      ? key
      : { id: key.id, name: key.name, claims: key.claims, preset: key.preset }
  })
  return { data, total: total?.value ?? 0, limit, offset }
}

export async function createKey({ db }: Deps, principal: Principal, body: KeyCreate): Promise<ApiKeyCreated> {
  assertCan(principal, "create", "Key")
  const { row, secret } = await createApiKey(db, {
    name: body.name,
    claims: resolvedClaims(body),
    expires_at: body.expires_at ? new Date(body.expires_at) : null,
  })
  return { ...toApiKey(row), secret }
}

export async function getKey({ db }: Deps, principal: Principal, id: string): Promise<ApiKey> {
  assertCan(principal, "read", "Key")
  const row = await db.selectFrom("api_keys").selectAll().where("id", "=", id).limit(1).executeTakeFirst()
  if (!row) throw ApiError.notFound("key")
  return toApiKey(row)
}

export async function updateKey({ db }: Deps, principal: Principal, id: string, patch: KeyPatch): Promise<ApiKey> {
  assertCan(principal, "update", "Key")
  if ((patch.claims !== undefined || patch.preset !== undefined) && id === principal.keyId)
    throw ApiError.forbidden("you cannot change the claims of the key you are using")
  const row = await db
    .updateTable("api_keys")
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.claims !== undefined || patch.preset !== undefined
        ? { claims: JSON.stringify(resolvedClaims(patch)) }
        : {}),
      ...(patch.expires_at !== undefined
        ? { expires_at: patch.expires_at ? new Date(patch.expires_at) : null }
        : {}),
      updated_at: new Date(),
    })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirst()
  if (!row) throw ApiError.notFound("key")
  return toApiKey(row)
}

/** A real delete: a revoked key leaves nothing behind. */
export async function revokeKey({ db }: Deps, principal: Principal, id: string): Promise<void> {
  assertCan(principal, "delete", "Key")
  if (id === principal.keyId) throw ApiError.forbidden("you cannot revoke the key you are using")
  const row = await db.deleteFrom("api_keys").where("id", "=", id).returning("id").executeTakeFirst()
  if (!row) throw ApiError.notFound("key")
}

/**
 * The calling key itself. The Client UI gates its menus on this, and its server
 * probe uses it to tell a linq instance from anything else that answers.
 */
export async function getCallingKey({ db }: Deps, principal: Principal): Promise<ApiKey> {
  const row = await db
    .selectFrom("api_keys")
    .selectAll()
    .where("id", "=", principal.keyId)
    .limit(1)
    .executeTakeFirst()

  // The key authenticated moments ago, so its row cannot be missing without a
  // concurrent revoke; 404 says so rather than serialising undefined.
  if (!row) throw new Error("the calling key vanished mid-request")
  return toApiKey(row)
}
