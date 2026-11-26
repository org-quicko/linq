import type { Link, LinkTree, LinkTreeItemJoinedRow, LinkTreeRow } from "@linq/shared"
import { UrlUtil } from "../../utils/index.ts"

/**
 * Maps a Link Tree's Link, its `link_trees` row and its joined Items to the
 * JSON shape the API returns.
 *
 * @param link - The tree's Link, as the API returns it.
 * @param tree - Its `link_trees` row.
 * @param items - Its Items with their target Links, in `position` order.
 * @returns The API `LinkTree`.
 */
export class LinkTreeRowsToLinkTreeConverter {
  convertFrom(link: Link, tree: LinkTreeRow, items: LinkTreeItemJoinedRow[]): LinkTree {
    return {
      ...link,
      tree: {
        image_url: tree.image_url,
        appearance: tree.appearance,
        accent: tree.accent,
        button_style: tree.button_style,
        items: items.map((item) => ({
          id: item.id,
          label: item.label,
          link: {
            id: item.link_id,
            slug: item.slug,
            short_url: UrlUtil.shortUrl(item.domain_host, item.slug),
            name: item.name,
            destination: item.destination,
            status: item.status,
            expires_at: item.expires_at?.toISOString() ?? null,
          },
        })),
      },
    }
  }
}
