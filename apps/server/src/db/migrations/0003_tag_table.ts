import { type Kysely, sql } from "kysely"

/**
 * Moves tags off `links.tags` into their own table. See docs/adr/0020.
 *
 * Backfills from the array column, then drops it, in one migration: there is
 * no down migration, so a server rolled back past this one cannot read tags.
 * `DISTINCT` collapses the duplicates the array allowed. Backfilled ids are
 * UUIDv4 (`gen_random_uuid`), new ones UUIDv7 — nothing orders tags by id.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE tags (
      id uuid PRIMARY KEY,
      name text NOT NULL CONSTRAINT tags_name_unique UNIQUE,
      created_at timestamp with time zone DEFAULT now() NOT NULL
    )
  `.execute(db)
  await sql`
    CREATE TABLE link_tags (
      link_id uuid NOT NULL CONSTRAINT link_tags_link_id_links_id_fk REFERENCES links(id) ON DELETE CASCADE,
      tag_id uuid NOT NULL CONSTRAINT link_tags_tag_id_tags_id_fk REFERENCES tags(id) ON DELETE RESTRICT,
      PRIMARY KEY (link_id, tag_id)
    )
  `.execute(db)
  await sql`CREATE INDEX link_tags_tag_id_idx ON link_tags (tag_id)`.execute(db)

  await sql`
    INSERT INTO tags (id, name)
    SELECT gen_random_uuid(), name FROM (SELECT DISTINCT unnest(tags) AS name FROM links) s
  `.execute(db)
  await sql`
    INSERT INTO link_tags (link_id, tag_id)
    SELECT DISTINCT l.id, t.id
    FROM links l
    CROSS JOIN LATERAL unnest(l.tags) AS u(name)
    JOIN tags t ON t.name = u.name
  `.execute(db)

  await sql`DROP INDEX links_tags_idx`.execute(db)
  await sql`ALTER TABLE links DROP COLUMN tags`.execute(db)
}
