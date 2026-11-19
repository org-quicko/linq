import { type ApiKeyCreateBody, type ApiKeyCreateInput, PermissionUtil } from "@linq/shared"

/**
 * Maps a `POST /keys` body to what `ApiKeyService.create` takes.
 *
 * @param body - The validated create body.
 * @returns The key's name, resolved claims and expiry.
 */
export class ApiKeyCreateBodyToApiKeyCreateInputConverter {
  convertFrom(body: ApiKeyCreateBody): ApiKeyCreateInput {
    return {
      name: body.name,
      claims: PermissionUtil.resolveClaims(body),
      expiresAt: body.expires_at ? new Date(body.expires_at) : null,
    }
  }
}
