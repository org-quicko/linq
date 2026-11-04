import { type Kysely, sql } from "kysely"

/**
 * Adds device_type (mobile | tablet | desktop) as an analytics dimension.
 *
 * `platform` stays as it is: it is the android | ios | desktop routing value
 * Rules match on, not a device class. device_type is generated from
 * `user_agent`, like `referer_host` (resources/docs/adr/0015), so adding it backfills
 * every existing visit with the same rule new visits get, and a rolled-back
 * server still writes it. Null when there is no user agent. Tablet is checked
 * first because Android tablets omit "Mobile"; iPadOS Safari reports itself as
 * a Mac, so it counts as desktop.
 *
 * The ADD rewrites `visits` (as in 0004 and 0005), and its lock holds off
 * inserts until commit, so no visit lands between the trigger swap and the
 * rollup backfill. `visit_dimension` is rebuilt through `text` and
 * `visits_analytics_idx` re-created with the new column, both as in 0005, which
 * explains why. One statement per entry, because PGlite rejects
 * multi-statement queries.
 */
const DEVICE_TYPE = `CASE
      WHEN nullif(btrim(user_agent), '') IS NULL THEN NULL
      WHEN user_agent ~* 'ipad|tablet|kindle|silk/|playbook' OR (user_agent ~* 'android' AND user_agent !~* 'mobi') THEN 'tablet'
      WHEN user_agent ~* 'mobi|iphone|ipod|android|blackberry|opera mini|windows phone' THEN 'mobile'
      ELSE 'desktop'
    END`

const statements = [
  `DROP INDEX visits_analytics_idx`,
  `ALTER TABLE visits ADD COLUMN device_type text GENERATED ALWAYS AS (${DEVICE_TYPE}) STORED`,

  `CREATE TYPE visit_dimension_new AS ENUM ('total', 'platform', 'os', 'browser', 'referer', 'destination', 'slug', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'device_type')`,
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
    new.occurred_at
  )
  ON CONFLICT ("domain_id", "link_id") DO UPDATE SET
    "human" = "visit_counts"."human" + excluded."human",
    "bot" = "visit_counts"."bot" + excluded."bot",
    "last_visit_at" = greatest("visit_counts"."last_visit_at", excluded."last_visit_at");
  RETURN NULL;
END $$`,

  `INSERT INTO visit_days (day, domain_id, link_id, dimension, value, is_bot, count)
    SELECT (occurred_at AT TIME ZONE 'UTC')::date, domain_id, link_id, 'device_type', coalesce(device_type, ''), is_bot, count(*)
    FROM visits GROUP BY 1, 2, 3, 5, 6`,

  // Keeps device-type-filtered reports index-only. See resources/docs/adr/0015.
  `CREATE INDEX visits_analytics_idx ON visits
    (occurred_at DESC NULLS LAST, is_bot, platform, link_id, domain_id, os, browser, referer_host, slug_requested, utm_source, utm_medium, utm_campaign, utm_content, utm_term, device_type)`,
]

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of statements) await sql.raw(statement).execute(db)
}
