-- os/browser join platform as chartable dimensions, the same way platform
-- itself already is.
ALTER TYPE "public"."visit_dimension" ADD VALUE 'os' BEFORE 'referer';--> statement-breakpoint
ALTER TYPE "public"."visit_dimension" ADD VALUE 'browser' BEFORE 'referer';--> statement-breakpoint
-- No backfill, same call 0011 made for the columns these dimensions roll up
-- from: only a future visit is counted under either one.
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
    ('referer'::visit_dimension,     coalesce(new.referer, '')::text),
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
END $$;
