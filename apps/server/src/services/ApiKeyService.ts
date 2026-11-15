import { createHash, randomBytes } from "node:crypto"
import {
  type ApiKey,
  type ApiKeySummary,
  type Claim,
  claimsForPreset,
  claimsSchema,
  type KeyPreset,
  presetForClaims,
} from "@linq/shared"
import type { Selectable } from "kysely"
import type { DB } from "../db/types.generated.ts"
import type { Db } from "../libs/index.ts"

type ApiKeyRow = Selectable<DB["api_keys"]>

/** SHA-256 hex of a key. This is what `api_keys.key_hash` holds; the secret never is. */
function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

/** Maps a key row to the JSON shape the API returns. */
export function toApiKey(row: ApiKeyRow): ApiKey {
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

/** A request names either a preset or an explicit claim list; this is the list either way. */
export function resolveClaims(input: { preset?: KeyPreset; claims?: unknown }): Claim[] {
  return input.preset ? [...claimsForPreset[input.preset]] : claimsSchema.parse(input.claims)
}

/**
 * Mints a key: `linq_` + 32 random bytes, base64url. The secret is returned to
 * the caller exactly once; only its hash and a short display prefix are stored.
 * Shared by `POST /keys`, `bun run key:create` and the first-boot bootstrap.
 */
export async function createApiKey(
  db: Db,
  input: { name: string; claims: readonly Claim[]; expiresAt?: Date | null },
) {
  const secret = `linq_${randomBytes(32).toString("base64url")}`
  const row = await db
    .insertInto("api_keys")
    .values({
      id: Bun.randomUUIDv7(),
      name: input.name,
      claims: JSON.stringify(input.claims),
      key_hash: hashKey(secret),
      // Stored alongside the hash so a key stays recognisable in lists.
      prefix: secret.slice(0, 12),
      expires_at: input.expiresAt ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  return { row, secret }
}

/** The key a bearer token names, expired or not. One indexed lookup, no join. */
export function findApiKeyByToken(db: Db, token: string) {
  return db
    .selectFrom("api_keys")
    .select(["id", "name", "claims", "expires_at"])
    .where("key_hash", "=", hashKey(token))
    .limit(1)
    .executeTakeFirst()
}

/**
 * Newest first. A caller that cannot manage keys sees only the summary shape:
 * enough to label a key, nothing about its lifetime or prefix.
 */
export async function listApiKeys(
  db: Db,
  { limit, offset, canManage }: { limit: number; offset: number; canManage: boolean },
) {
  const rows = await db
    .selectFrom("api_keys")
    .selectAll()
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(limit)
    .offset(offset)
    .execute()
  const { total = 0 } =
    (await db
      .selectFrom("api_keys")
      .select((eb) => eb.fn.countAll<number>().as("total"))
      .executeTakeFirst()) ?? {}
  const data: (ApiKey | ApiKeySummary)[] = rows.map((row) => {
    const key = toApiKey(row)
    return canManage ? key : { id: key.id, name: key.name, claims: key.claims, preset: key.preset }
  })
  return { data, total }
}

/** One key, or null when no row matches. */
export async function getApiKey(db: Db, id: string): Promise<ApiKey | null> {
  const row = await db
    .selectFrom("api_keys")
    .selectAll()
    .where("id", "=", id)
    .limit(1)
    .executeTakeFirst()
  return row ? toApiKey(row) : null
}

/** Applies only the fields present in `patch`. Null when no row matches. */
export async function updateApiKey(
  db: Db,
  id: string,
  patch: { name?: string; claims?: Claim[]; expiresAt?: Date | null },
): Promise<ApiKey | null> {
  const row = await db
    .updateTable("api_keys")
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.claims !== undefined ? { claims: JSON.stringify(patch.claims) } : {}),
      ...(patch.expiresAt !== undefined ? { expires_at: patch.expiresAt } : {}),
      updated_at: new Date(),
    })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirst()
  return row ? toApiKey(row) : null
}

/** Revocation is a real delete. False when no row matches. */
export async function deleteApiKey(db: Db, id: string): Promise<boolean> {
  const row = await db
    .deleteFrom("api_keys")
    .where("id", "=", id)
    .returning("id")
    .executeTakeFirst()
  return row !== undefined
}
