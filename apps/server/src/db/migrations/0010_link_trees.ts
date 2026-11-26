import { type Kysely, sql } from "kysely"

/**
 * Adds Link Trees: a Link of type `tree` that serves a page listing Items, each
 * targeting a redirect Link on the same Domain. See resources/docs/adr/0023.
 *
 * Every existing row becomes a `redirect`, so no data moves. `destination` turns
 * nullable, but the check keeps it set for exactly the redirect Links. The page's
 * title and description are the Link's own `name` and `description`; only its
 * appearance lives in `link_trees`. Purging either side of an Item removes the
 * Item with it. One statement per entry, because PGlite rejects multi-statement
 * queries.
 */
const statements = [
  `CREATE TYPE link_type AS ENUM ('redirect', 'tree')`,
  `ALTER TABLE links ADD COLUMN type link_type DEFAULT 'redirect' NOT NULL`,
  `ALTER TABLE links ALTER COLUMN destination DROP NOT NULL`,
  `ALTER TABLE links ADD CONSTRAINT links_destination_by_type CHECK ((type = 'redirect') = (destination IS NOT NULL))`,

  `CREATE TABLE link_trees (
    link_id uuid PRIMARY KEY CONSTRAINT link_trees_link_id_links_id_fk REFERENCES links(id) ON DELETE CASCADE,
    image_url text,
    appearance text DEFAULT 'auto' NOT NULL CONSTRAINT link_trees_appearance_check CHECK (appearance IN ('auto', 'light', 'dark')),
    accent text DEFAULT '#171717' NOT NULL CONSTRAINT link_trees_accent_check CHECK (accent ~ '^#[0-9a-f]{6}$'),
    button_style text DEFAULT 'filled' NOT NULL CONSTRAINT link_trees_button_style_check CHECK (button_style IN ('filled', 'outline', 'soft'))
  )`,

  `CREATE TABLE link_tree_items (
    id uuid PRIMARY KEY,
    tree_id uuid NOT NULL CONSTRAINT link_tree_items_tree_id_links_id_fk REFERENCES links(id) ON DELETE CASCADE,
    "position" integer NOT NULL,
    label text NOT NULL,
    link_id uuid NOT NULL CONSTRAINT link_tree_items_link_id_links_id_fk REFERENCES links(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX link_tree_items_tree_position_key ON link_tree_items (tree_id, "position")`,
  // Finds the trees to clear from the cache when a target Link changes.
  `CREATE INDEX link_tree_items_link_id_idx ON link_tree_items (link_id)`,
]

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of statements) await sql.raw(statement).execute(db)
}
