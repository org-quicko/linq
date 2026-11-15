import { type Kysely, sql } from "kysely"

/**
 * Renames three `visits` columns to say what they hold:
 *
 *   occurred_at        -> visited_at
 *   bot_classification -> bot_classification_reason (and its enum type)
 *   query              -> query_params
 *
 * Every rename is a catalog-only change: no row is rewritten, so it costs the
 * same on millions of visits as on none. Indexes, the `referer_host`/`utm_*`/
 * `device_type` generated columns and defaults follow a rename by themselves.
 * The trigger function does not: a plpgsql body is stored as text, so
 * `record_visit_rollup()` is replaced here with the new column name, in the
 * same transaction, or the next visit insert would fail.
 *
 * Each rename takes a brief ACCESS EXCLUSIVE lock on `visits`, waiting for
 * any query already running on it to finish. Not backward compatible with a
 * server older than this migration: stop the old server before starting this
 * one. A manual rollback is in resources/sql/rollback/0008_rename_visit_columns.sql.
 */
const statements = [
  `ALTER TABLE visits RENAME COLUMN occurred_at TO visited_at`,
  `ALTER TABLE visits RENAME COLUMN bot_classification TO bot_classification_reason`,
  `ALTER TABLE visits RENAME COLUMN query TO query_params`,
  `ALTER TYPE bot_classification RENAME TO bot_classification_reason`,

  `ALTER INDEX visits_link_occurred_idx RENAME TO visits_link_visited_idx`,
  `ALTER INDEX visits_domain_occurred_idx RENAME TO visits_domain_visited_idx`,
  `ALTER INDEX visits_orphan_occurred_idx RENAME TO visits_orphan_visited_idx`,

  // Identical to 0006's body except `new.visited_at`.
  `CREATE OR REPLACE FUNCTION record_visit_rollup() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  d date := (new.visited_at AT TIME ZONE 'UTC')::date;
BEGIN
  INSERT INTO "visit_days" ("day", "domain_id", "link_id", "dimension", "value", "is_bot", "count")
  SELECT d, new.domain_id, new.link_id, dims.dim, dims.val, new.is_bot, 1
  FROM (VALUES
    ('total'::visit_dimension,        ''::text),
    ('platform'::visit_dimension,     new.platform::text),
    ('os'::visit_dimension,           coalesce(new.os, '')::text),
    ('browser'::visit_dimension,      coalesce(new.browser, '')::text),
    ('referer'::visit_dimension,      coalesce(new.referer_host, '')::text),
    ('destination'::visit_dimension,  coalesce(new.destination, '')::text),
    ('slug'::visit_dimension,         new.slug_requested::text),
    ('utm_source'::visit_dimension,   coalesce(new.utm_source, '')::text),
    ('utm_medium'::visit_dimension,   coalesce(new.utm_medium, '')::text),
    ('utm_campaign'::visit_dimension, coalesce(new.utm_campaign, '')::text),
    ('utm_content'::visit_dimension,  coalesce(new.utm_content, '')::text),
    ('utm_term'::visit_dimension,     coalesce(new.utm_term, '')::text),
    ('device_type'::visit_dimension,  coalesce(new.device_type, '')::text)
  ) AS dims(dim, val)
  ON CONFLICT ("day", "domain_id", "link_id", "dimension", "value", "is_bot")
    DO UPDATE SET "count" = "visit_days"."count" + 1;
  INSERT INTO "visit_counts" ("domain_id", "link_id", "human", "bot", "last_visit_at")
  VALUES (
    new.domain_id,
    new.link_id,
    CASE WHEN new.is_bot THEN 0 ELSE 1 END,
    CASE WHEN new.is_bot THEN 1 ELSE 0 END,
    new.visited_at
  )
  ON CONFLICT ("domain_id", "link_id") DO UPDATE SET
    "human" = "visit_counts"."human" + excluded."human",
    "bot" = "visit_counts"."bot" + excluded."bot",
    "last_visit_at" = greatest("visit_counts"."last_visit_at", excluded."last_visit_at");
  RETURN NULL;
END $$`,
]

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of statements) await sql.raw(statement).execute(db)
}
