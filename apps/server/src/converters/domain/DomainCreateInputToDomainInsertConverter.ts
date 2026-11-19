import type { DomainCreateInput, DomainInsert } from "@linq/shared"

/**
 * Maps a create request to the `domains` columns it sets; the caller adds `id`.
 *
 * @param input - The validated create body.
 * @returns The insert row, minus `id`.
 */
export class DomainCreateInputToDomainInsertConverter {
  convertFrom(input: DomainCreateInput): DomainInsert {
    return {
      host: input.host,
      fallback_url: input.fallback_url ?? null,
      base_path_redirect: input.base_path_redirect ?? null,
      invalid_short_url_redirect: input.invalid_short_url_redirect ?? null,
    }
  }
}
