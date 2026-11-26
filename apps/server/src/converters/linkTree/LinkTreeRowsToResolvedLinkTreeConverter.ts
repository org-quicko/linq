import type { LinkRow, LinkTreeItemJoinedRow, LinkTreeRow, ResolvedLinkTree } from "@linq/shared"

/**
 * Folds a Link Tree into the page the redirect caches. Item URLs are
 * root-relative: an Item always targets a Link on the tree's own Domain, so
 * the browser resolves it against whichever host the page was served on.
 *
 * @param link - The tree's `links` row.
 * @param tree - Its `link_trees` row.
 * @param items - Its active Items with their target Links, in `position` order.
 * @returns The cacheable page.
 */
export class LinkTreeRowsToResolvedLinkTreeConverter {
  convertFrom(link: LinkRow, tree: LinkTreeRow, items: LinkTreeItemJoinedRow[]): ResolvedLinkTree {
    return {
      title: link.name ?? link.slug,
      description: link.description,
      image_url: tree.image_url,
      appearance: tree.appearance,
      accent: tree.accent,
      button_style: tree.button_style,
      items: items.map((item) => ({
        label: item.label,
        url: `/${item.slug}`,
        expires_at: item.expires_at?.getTime() ?? null,
      })),
    }
  }
}
