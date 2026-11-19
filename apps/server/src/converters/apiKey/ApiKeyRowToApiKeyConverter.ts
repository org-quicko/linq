import { type ApiKey, type ApiKeyRow, claimsSchema, PermissionUtil } from "@linq/shared"

/**
 * Maps a key row to the JSON shape the API returns.
 *
 * @param row - An `api_keys` row.
 * @returns The API `ApiKey`.
 */
export class ApiKeyRowToApiKeyConverter {
  convertFrom(row: ApiKeyRow): ApiKey {
    const claims = claimsSchema.parse(row.claims)
    return {
      id: row.id,
      name: row.name,
      claims,
      preset: PermissionUtil.presetForClaims(claims),
      prefix: row.prefix,
      expires_at: row.expires_at?.toISOString() ?? null,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    }
  }
}
