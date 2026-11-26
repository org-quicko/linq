import type { LinkInsert, LinkTreeCreateInput } from "@linq/shared"

/**
 * Maps a Link Tree create request to its `links` row; the caller adds `id`.
 * A tree has no Destination and nothing to forward, and is never listed in
 * llms.txt.
 *
 * @param input - The validated create body.
 * @param slug - The slug being tried for this insert.
 * @returns The insert row, minus `id`.
 */
export class LinkTreeCreateInputToLinkInsertConverter {
  convertFrom(input: LinkTreeCreateInput, slug: string): LinkInsert {
    return {
      slug,
      domain_id: input.domain_id,
      type: "tree",
      destination: null,
      name: input.name,
      description: input.description ?? null,
      icon_url: null,
      forward_query_params: false,
      preset_params: {},
      expires_at: null,
      listed: false,
    }
  }
}
