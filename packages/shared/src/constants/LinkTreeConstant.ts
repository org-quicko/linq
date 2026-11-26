/** What a Link is: a redirect to a Destination, or a Link Tree page. */
export const LINK_TYPES = ["redirect", "tree"] as const

/** Which colour scheme a Link Tree page uses. `auto` follows the visitor's system. */
export const LINK_TREE_APPEARANCES = ["auto", "light", "dark"] as const

/** How a Link Tree page draws its Items: solid accent, accent outline, or a tint of it. */
export const LINK_TREE_BUTTON_STYLES = ["filled", "outline", "soft"] as const

/** The accent a new Link Tree starts with: near-black, matching the Client UI. */
export const LINK_TREE_DEFAULT_ACCENT = "#171717"

/** The curated accents the editor offers before a custom hex. Each one carries
 *  readable text in either black or white (see `LinkTreeUtil.contrastText`). */
export const LINK_TREE_ACCENTS = [
  "#171717",
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#dc2626",
  "#ea580c",
  "#16a34a",
  "#0d9488",
] as const

/** Items on one Link Tree. A page longer than this stops being scannable. */
export const LINK_TREE_MAX_ITEMS = 50
