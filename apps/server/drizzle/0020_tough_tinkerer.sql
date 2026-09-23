-- Referrers roll up by host, not by full URL, and filtered reports read
-- the visit log through a covering index. docs/adr/0015.
-- '' when there was no referer, and also when it was relative (a same-site
-- referer) — both read as "not recorded", which is what the rollup's ''
-- already means. www. is deliberately not stripped: it is a different host.
CREATE FUNCTION referer_host(u text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(regexp_replace(regexp_replace(coalesce(u, ''),
    '^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^@/]*@)?', ''), '[/?#:].*$', ''))
$$;--> statement-breakpoint
-- A full table rewrite under ACCESS EXCLUSIVE, and migrations run at boot
-- (src/db/migrate.ts) — a large instance's first start after upgrading
-- blocks on it. In exchange Postgres backfills every existing row, so
-- there is no separate backfill UPDATE.
ALTER TABLE "visits" ADD COLUMN "referer_host" text GENERATED ALWAYS AS (referer_host("referer")) STORED;--> statement-breakpoint
ALTER TABLE "visits" SET (autovacuum_vacuum_insert_scale_factor = 0.02);--> statement-breakpoint
CREATE INDEX "visit_days_dimension_day_idx" ON "visit_days" USING btree ("dimension","day");--> statement-breakpoint
CREATE INDEX "visits_analytics_idx" ON "visits" USING btree ("occurred_at" DESC NULLS LAST,"is_bot","platform","link_id","domain_id","os","browser","referer_host","slug_requested");--> statement-breakpoint
-- Whole body re-pasted from 0017_drop_bot_label.sql; only the 'referer' row
-- changes. The visit_counts upsert at the bottom is copied verbatim too — a
-- partial CREATE OR REPLACE silently stops maintaining the table every link
-- list reads.
CREATE OR REPLACE FUNCTION record_visit_rollup() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  d date := (new.occurred_at AT TIME ZONE 'UTC')::date;
BEGIN
  INSERT INTO "visit_days" ("day", "domain_id", "link_id", "dimension", "value", "is_bot", "count")
  SELECT d, new.domain_id, new.link_id, dims.dim, dims.val, new.is_bot, 1
  FROM (VALUES
    ('total'::visit_dimension,       ''::text),
    ('platform'::visit_dimension,    new.platform::text),
    ('os'::visit_dimension,          coalesce(new.os, '')::text),
    ('browser'::visit_dimension,     coalesce(new.browser, '')::text),
    ('referer'::visit_dimension,     coalesce(new.referer_host, '')::text),
    ('destination'::visit_dimension, coalesce(new.destination, '')::text),
    ('slug'::visit_dimension,        new.slug_requested::text)
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
END $$;--> statement-breakpoint
-- Rebuild the one dimension whose values changed meaning; the rest of
-- visit_days is untouched. ADR 0007 calls a rebuild from `visits` the
-- supported repair procedure — this is that, narrowed to one dimension.
--
-- Not safe against an old instance still inserting through the previous
-- function definition: those rows would be counted twice or not at all.
-- linq deploys as a single instance, so this is stated rather than
-- defended against.
DELETE FROM "visit_days" WHERE "dimension" = 'referer';--> statement-breakpoint
INSERT INTO "visit_days" ("day", "domain_id", "link_id", "dimension", "value", "is_bot", "count")
SELECT (v."occurred_at" AT TIME ZONE 'UTC')::date, v."domain_id", v."link_id",
       'referer'::visit_dimension, coalesce(v."referer_host", ''), v."is_bot", count(*)
FROM "visits" v
GROUP BY 1, 2, 3, 5, 6;
-- No VACUUM ANALYZE here: drizzle's migrator runs every pending migration
-- file inside one transaction (pg-core/dialect.js `migrate()`), and VACUUM
-- cannot run inside a transaction block — it would fail the whole migration.
-- autovacuum_vacuum_insert_scale_factor above (§B2) is what actually keeps
-- the visibility map current going forward; an operator upgrading a large,
-- already-populated instance should run `VACUUM ANALYZE visits;` by hand
-- right after this migration so the covering index is index-only-eligible
-- immediately rather than waiting on autovacuum's own schedule.
