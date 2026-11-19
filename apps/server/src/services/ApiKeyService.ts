import { randomBytes } from "node:crypto"
import type { ApiKey, ApiKeyPatchInput, ApiKeySummary, Claim } from "@linq/shared"
import type { Db } from "../clients/index.ts"
import { ApiKeyRowToApiKeyConverter, ApiKeyToApiKeySummaryConverter } from "../converters/index.ts"
import { HashUtil } from "../utils/index.ts"

const apiKeyRowToApiKeyConverter = new ApiKeyRowToApiKeyConverter()
const apiKeyToApiKeySummaryConverter = new ApiKeyToApiKeySummaryConverter()

/**
 * API keys: minting, the bearer-token lookup `authenticate` runs on every API
 * request, and CRUD. Shared by `/keys`, `/me`, `bun run key:create` and the
 * first-boot bootstrap.
 */
export class ApiKeyService {
  /**
   * @param db - The database.
   */
  constructor(private readonly db: Db) {}

  /**
   * Mints a key: `linq_` + 32 random bytes, base64url. The secret is returned to
   * the caller exactly once; only its hash and a short display prefix are stored.
   *
   * @param input - The key's name, claims and optional expiry.
   * @returns The stored row, and the plaintext secret.
   */
  async create(input: { name: string; claims: readonly Claim[]; expiresAt?: Date | null }) {
    const secret = `linq_${randomBytes(32).toString("base64url")}`
    const row = await this.db
      .insertInto("api_keys")
      .values({
        id: Bun.randomUUIDv7(),
        name: input.name,
        claims: JSON.stringify(input.claims),
        key_hash: HashUtil.hashKey(secret),
        // Stored alongside the hash so a key stays recognisable in lists.
        prefix: secret.slice(0, 12),
        expires_at: input.expiresAt ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return { row, secret }
  }

  /**
   * The key a bearer token names, expired or not. One indexed lookup, no join.
   *
   * @param token - The plaintext bearer token.
   * @returns The key's id, name, claims and expiry, or undefined when none matches.
   */
  findByToken(token: string) {
    return this.db
      .selectFrom("api_keys")
      .select(["id", "name", "claims", "expires_at"])
      .where("key_hash", "=", HashUtil.hashKey(token))
      .limit(1)
      .executeTakeFirst()
  }

  /**
   * Lists keys, newest first. A caller that cannot manage keys sees only the
   * summary shape: enough to label a key, nothing about its lifetime or prefix.
   *
   * @param page - The page to read, and whether the caller may manage keys.
   * @returns The page, and the total.
   */
  async list({ limit, offset, canManage }: { limit: number; offset: number; canManage: boolean }) {
    const rows = await this.db
      .selectFrom("api_keys")
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .offset(offset)
      .execute()
    const { total = 0 } =
      (await this.db
        .selectFrom("api_keys")
        .select((eb) => eb.fn.countAll<number>().as("total"))
        .executeTakeFirst()) ?? {}
    const data: (ApiKey | ApiKeySummary)[] = rows.map((row) =>
      canManage
        ? apiKeyRowToApiKeyConverter.convertFrom(row)
        : apiKeyToApiKeySummaryConverter.convertFrom(apiKeyRowToApiKeyConverter.convertFrom(row)),
    )
    return { data, total }
  }

  /**
   * Loads one key.
   *
   * @param id - id of the key.
   * @returns The key, or null when no row matches.
   */
  async get(id: string): Promise<ApiKey | null> {
    const row = await this.db
      .selectFrom("api_keys")
      .selectAll()
      .where("id", "=", id)
      .limit(1)
      .executeTakeFirst()
    return row ? apiKeyRowToApiKeyConverter.convertFrom(row) : null
  }

  /**
   * Applies only the fields present in `patch`.
   *
   * @param id - id of the key.
   * @param patch - The fields to change.
   * @returns The updated key, or null when no row matches.
   */
  async update(id: string, patch: ApiKeyPatchInput): Promise<ApiKey | null> {
    const row = await this.db
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
    return row ? apiKeyRowToApiKeyConverter.convertFrom(row) : null
  }

  /**
   * Revokes a key. Revocation is a real delete.
   *
   * @param id - id of the key.
   * @returns False when no row matches.
   */
  async delete(id: string): Promise<boolean> {
    const row = await this.db
      .deleteFrom("api_keys")
      .where("id", "=", id)
      .returning("id")
      .executeTakeFirst()
    return row !== undefined
  }
}
