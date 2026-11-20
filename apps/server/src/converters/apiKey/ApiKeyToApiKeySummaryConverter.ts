import type { ApiKey, ApiKeySummary } from "@linq/shared"

/**
 * Trims a key to what a caller that cannot manage keys may see: enough to
 * label it, nothing about its lifetime or prefix.
 *
 * @param key - The full API key.
 * @returns The summary shape.
 */
export class ApiKeyToApiKeySummaryConverter {
  convertFrom(key: ApiKey): ApiKeySummary {
    return { id: key.id, name: key.name, claims: key.claims, preset: key.preset }
  }
}
