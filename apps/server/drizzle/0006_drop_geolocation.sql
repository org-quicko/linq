-- Geolocation is gone: nothing resolves a country any more, so both columns and
-- both rollup dimensions go with it. See docs/adr/0010.
--
-- PostgreSQL cannot drop a value from an enum, so `visit_dimension` is rebuilt
-- through text. Order matters twice: the rows holding the doomed values are
-- deleted before the recast, and the trigger stops reading the columns before
-- they are dropped.
DELETE FROM "visit_days" WHERE "dimension" IN ('country', 'region');--> statement-breakpoint
ALTER TABLE "visit_days" ALTER COLUMN "dimension" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."visit_dimension";--> statement-breakpoint
CREATE TYPE "public"."visit_dimension" AS ENUM('total', 'platform', 'referer', 'destination', 'slug');--> statement-breakpoint
ALTER TABLE "visit_days" ALTER COLUMN "dimension" SET DATA TYPE "public"."visit_dimension" USING "dimension"::"public"."visit_dimension";--> statement-breakpoint
CREATE OR REPLACE FUNCTION record_visit_rollup() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  d date := (new.occurred_at AT TIME ZONE 'UTC')::date;
BEGIN
  -- One row per dimension. `total` carries the day's whole count; the other four
  -- mirror the groupings the stats API offers, with '' where nothing was recorded.
  INSERT INTO "visit_days" ("day", "domain_id", "link_id", "dimension", "value", "is_bot", "count")
  SELECT d, new.domain_id, new.link_id, dims.dim, dims.val, new.is_bot, 1
  FROM (VALUES
    ('total'::visit_dimension,  ''::text),
    ('platform'::visit_dimension,     new.platform::text),
    ('referer'::visit_dimension,      coalesce(new.referer, '')::text),
    ('destination'::visit_dimension,  coalesce(new.destination, '')::text),
    ('slug'::visit_dimension,         new.slug_requested::text)
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
ALTER TABLE "visits" DROP COLUMN "country";--> statement-breakpoint
ALTER TABLE "visits" DROP COLUMN "region";--> statement-breakpoint
-- Rules carrying a `country` condition can no longer be evaluated. They are
-- deleted whole rather than having the condition stripped out: conditions are
-- ANDed, so removing one would BROADEN the rule and silently reroute traffic it
-- was written to exclude ("country=IN and platform=android" would start matching
-- every Android visitor). Deleting falls back to the link's default destination,
-- which is the safe direction to fail in.
DELETE FROM "rules" WHERE "conditions" @> '[{"type": "country"}]';--> statement-breakpoint
-- Close the gaps that leaves in each link's position sequence. Shifted clear of
-- the live range first: rules_link_position_key is checked row by row, so
-- renumbering in place can collide with a row that has not been updated yet.
UPDATE "rules" SET "position" = "position" + 1000000;--> statement-breakpoint
UPDATE "rules" r SET "position" = ordered.pos
FROM (
  SELECT "id", (row_number() OVER (PARTITION BY "link_id" ORDER BY "position") - 1)::integer AS pos
  FROM "rules"
) AS ordered
WHERE r."id" = ordered."id";
