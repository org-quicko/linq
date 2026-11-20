import { type ApiKeyPatchBody, type ApiKeyPatchInput, PermissionUtil } from "@linq/shared"

/**
 * Maps a `PATCH /keys/:id` body to what `updateApiKey` takes. A field left
 * undefined is left alone; `claims` is set only when the body names a preset
 * or a claim list.
 *
 * @param patch - The validated patch body.
 * @returns The fields to change.
 */
export class ApiKeyPatchBodyToApiKeyPatchInputConverter {
  convertFrom(patch: ApiKeyPatchBody): ApiKeyPatchInput {
    return {
      name: patch.name,
      claims:
        patch.claims !== undefined || patch.preset !== undefined
          ? PermissionUtil.resolveClaims(patch)
          : undefined,
      expiresAt:
        patch.expires_at === undefined
          ? undefined
          : patch.expires_at
            ? new Date(patch.expires_at)
            : null,
    }
  }
}
