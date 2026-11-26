import { type LinkCreateInput, type LinkInsert, LinkUtil, type Metadata } from "@linq/shared"

/**
 * Maps a create request to the `links` columns it sets; the caller adds `id`.
 *
 * @param input - The validated create body.
 * @param fetched - The destination's metadata.
 * @param slug - The slug being tried for this insert.
 * @returns The insert row, minus `id`.
 */
export class LinkCreateInputToLinkInsertConverter {
  convertFrom(input: LinkCreateInput, fetched: Metadata, slug: string): LinkInsert {
    return {
      slug,
      domain_id: input.domain_id,
      type: "redirect",
      destination: input.destination,
      // A link should always have a useful label even when metadata fetching is
      // disabled (the secure default) or the page has no title. A caller-supplied
      // name remains authoritative.
      name: input.name ?? fetched.name ?? LinkUtil.destinationTitle(input.destination),
      description: input.description ?? fetched.description ?? null,
      icon_url: fetched.icon_url,
      forward_query_params: input.forward_query_params,
      preset_params: input.preset_params,
      expires_at: input.expires_at ? new Date(input.expires_at) : null,
      listed: input.listed,
    }
  }
}
