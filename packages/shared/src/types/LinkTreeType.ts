import type { z } from "zod"
import type {
  LINK_TREE_APPEARANCES,
  LINK_TREE_BUTTON_STYLES,
  LINK_TYPES,
} from "../constants/index.ts"
import type {
  linkTreeCreateSchema,
  linkTreeItemInputSchema,
  linkTreePatchSchema,
} from "../schemas/index.ts"
import type { Link } from "./LinkType.ts"

export type LinkType = (typeof LINK_TYPES)[number]
export type LinkTreeAppearance = (typeof LINK_TREE_APPEARANCES)[number]
export type LinkTreeButtonStyle = (typeof LINK_TREE_BUTTON_STYLES)[number]

/** How a Link Tree page looks, apart from its title and description. */
export type LinkTreeStyle = {
  image_url: string | null
  appearance: LinkTreeAppearance
  accent: string
  button_style: LinkTreeButtonStyle
}

/** One Item as the API returns it, with the Link it targets. */
export type LinkTreeItem = {
  id: string
  label: string
  link: {
    id: string
    slug: string
    short_url: string
    name: string | null
    destination: string | null
    status: "active" | "archived"
    expires_at: string | null
  }
}

/** A Link Tree as the API returns it: the Link, plus its page. */
export type LinkTree = Link & { tree: LinkTreeStyle & { items: LinkTreeItem[] } }

/** A `POST /link-trees` body before defaults are applied, as a client sends it. */
export type LinkTreeCreate = z.input<typeof linkTreeCreateSchema>

/** A validated `POST /link-trees` body, defaults applied. */
export type LinkTreeCreateInput = z.infer<typeof linkTreeCreateSchema>

/** A validated `PATCH /link-trees/:id` body. */
export type LinkTreePatch = z.infer<typeof linkTreePatchSchema>

/** One Item as a client sends it. */
export type LinkTreeItemInput = z.infer<typeof linkTreeItemInputSchema>

/**
 * Everything the public page renders. The server builds it from the database
 * and the editor builds it from its form, so the preview and the live page come
 * from one renderer (`LinkTreeUtil.renderPage`).
 */
export type LinkTreePage = LinkTreeStyle & {
  title: string
  description: string | null
  items: { label: string; url: string }[]
}

/** A `link_trees` row. */
export type LinkTreeRow = LinkTreeStyle & { link_id: string }

/** A `link_tree_items` row. */
export type LinkTreeItemRow = {
  id: string
  tree_id: string
  position: number
  label: string
  link_id: string
}

/** A `link_tree_items` row joined to the Link it targets, in `position` order. */
export type LinkTreeItemJoinedRow = {
  id: string
  label: string
  link_id: string
  slug: string
  name: string | null
  destination: string | null
  status: "active" | "archived"
  expires_at: Date | null
  domain_host: string
}
