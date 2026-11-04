import { type Kysely, sql } from "kysely"

/**
 * Adds utm_content and utm_term as analytics dimensions, and caps every utm
 * value at 200 characters.
 *
 * The cap closes a hole in 0004. `visits_analytics_idx` carries the utm columns,
 * and Postgres refuses an index entry over about 2.7 KB, so one request with a
 * long, incompressible `utm_*` value failed the whole visit insert and the visit
 * was lost. utm_content and utm_term are free text (ad variants, search
 * keywords), which would have made that likelier. Generated columns cannot have
 * their expression changed before PostgreSQL 17, so the three from 0004 are
 * dropped and re-created with the new ones. The ADD is the only table rewrite,
 * and it backfills every existing visit, as in 0004.
 *
 * The rollup rows for all five are rebuilt from `visits` afterwards, so a value
 * that was over the cap rolls up under its truncated form and the rollup keeps
 * equalling a live aggregate (resources/docs/adr/0007). The `visit_dimension` rebuild
 * through `text` and the single transaction are as in 0004, which explains
 * both. One statement per entry, because PGlite rejects multi-statement queries.
 */
const OLD = ["utm_source", "utm_medium", "utm_campaign"] as const
const UTM = [...OLD, "utm_content", "utm_term"] as const
const CAP = 200

const statements = [
  // The index names the columns about to be dropped, so it goes first.
  `DROP INDEX visits_analytics_idx`,
  `ALTER TABLE visits ${OLD.map((k) => `DROP COLUMN ${k}`).join(", ")}`,
  `ALTER TABLE visits
    ${UTM.map((k) => `ADD COLUMN ${k} text GENERATED ALWAYS AS (nullif(left(lower(btrim(query->'${k}'->>0)), ${CAP}), '')) STORED`).join(",\n    ")}`,

  `CREATE TYPE visit_dimension_new AS ENUM ('total', 'platform', 'os', 'browser', 'referer', 'destination', 'slug', ${UTM.map((k) => `'${k}'`).join(", ")})`,
  `ALTER TABLE visit_days ALTER COLUMN dimension TYPE visit_dimension_new USING dimension::text::visit_dimension_new`,
  `DROP TYPE visit_dimension`,
  `ALTER TYPE visit_dimension_new RENAME TO visit_dimension`,

  `CREATE OR REPLACE FUNCTION record_visit_rollup() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  d date := (new.occurred_at AT TIME ZONE 'UTC')::date;
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
    ('utm_term'::visit_dimension,     coalesce(new.utm_term, '')::text)
  ) AS dims(dim, val)
  ON CONFLICT ("day", "domain_id", "link_id", "dimension", "value", "is_bot")
    DO UPDATE SET "count" = "visit_days"."count" + 1;
  INSERT INTO "visit_counts" ("domain_id", "link_id", "human", "bot", "last_visit_at")
  VALUES (
    new.domain_id,
    new.link_id,
    CASE WHEN new.is_bot THEN 0 ELSE 1 END,
    CASE WHEN new.is_bot THEN 1 ELSE 0 END,
    new.occurred_at
  )
  ON CONFLICT ("domain_id", "link_id") DO UPDATE SET
    "human" = "visit_counts"."human" + excluded."human",
    "bot" = "visit_counts"."bot" + excluded."bot",
    "last_visit_at" = greatest("visit_counts"."last_visit_at", excluded."last_visit_at");
  RETURN NULL;
END $$`,

  // Rebuilt rather than patched: 0004's rows may hold values over the cap.
  `DELETE FROM visit_days WHERE dimension::text LIKE 'utm\\_%'`,
  ...UTM.map(
    (k) => `INSERT INTO visit_days (day, domain_id, link_id, dimension, value, is_bot, count)
    SELECT (occurred_at AT TIME ZONE 'UTC')::date, domain_id, link_id, '${k}', coalesce(${k}, ''), is_bot, count(*)
    FROM visits GROUP BY 1, 2, 3, 5, 6`,
  ),

  // Keeps UTM-filtered reports index-only. See resources/docs/adr/0015.
  `CREATE INDEX visits_analytics_idx ON visits
    (occurred_at DESC NULLS LAST, is_bot, platform, link_id, domain_id, os, browser, referer_host, slug_requested, ${UTM.join(", ")})`,
]

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of statements) await sql.raw(statement).execute(db)
}
