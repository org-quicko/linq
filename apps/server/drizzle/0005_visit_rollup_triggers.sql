-- Keeps visit_days and visit_counts exact, in the same transaction as the visit
-- that caused them. Only these functions write to either table. See docs/adr/0007.

CREATE FUNCTION record_visit_rollup() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  d date := (new.occurred_at AT TIME ZONE 'UTC')::date;
BEGIN
  -- One row per dimension. `total` carries the day's whole count; the other six
  -- mirror the groupings the stats API offers, with '' where nothing was recorded.
  INSERT INTO "visit_days" ("day", "domain_id", "link_id", "dimension", "value", "is_bot", "count")
  SELECT d, new.domain_id, new.link_id, dims.dim, dims.val, new.is_bot, 1
  FROM (VALUES
    ('total'::visit_dimension,  ''::text),
    ('country'::visit_dimension,      coalesce(new.country, '')::text),
    ('region'::visit_dimension,       coalesce(new.region, '')::text),
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
END $$;
--> statement-breakpoint
-- Purging a link turns its visits into orphans through `visits.link_id`'s
-- ON DELETE SET NULL, so its rollups have to follow. Set-based rather than row
-- by row: one merge and one delete per table, whatever the link's history.
CREATE FUNCTION orphan_visit_rollups() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "visit_days" ("day", "domain_id", "link_id", "dimension", "value", "is_bot", "count")
  SELECT "day", "domain_id", NULL::uuid, "dimension", "value", "is_bot", sum("count")::bigint
  FROM "visit_days"
  WHERE "link_id" = old.id
  GROUP BY "day", "domain_id", "dimension", "value", "is_bot"
  ON CONFLICT ("day", "domain_id", "link_id", "dimension", "value", "is_bot")
    DO UPDATE SET "count" = "visit_days"."count" + excluded."count";

  DELETE FROM "visit_days" WHERE "link_id" = old.id;

  INSERT INTO "visit_counts" ("domain_id", "link_id", "human", "bot", "last_visit_at")
  SELECT "domain_id", NULL::uuid, "human", "bot", "last_visit_at"
  FROM "visit_counts"
  WHERE "link_id" = old.id
  ON CONFLICT ("domain_id", "link_id") DO UPDATE SET
    "human" = "visit_counts"."human" + excluded."human",
    "bot" = "visit_counts"."bot" + excluded."bot",
    "last_visit_at" = greatest("visit_counts"."last_visit_at", excluded."last_visit_at");

  DELETE FROM "visit_counts" WHERE "link_id" = old.id;

  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER "visits_rollup" AFTER INSERT ON "visits"
  FOR EACH ROW EXECUTE FUNCTION record_visit_rollup();
--> statement-breakpoint
CREATE TRIGGER "links_purge_rollup" AFTER DELETE ON "links"
  FOR EACH ROW EXECUTE FUNCTION orphan_visit_rollups();
--> statement-breakpoint
-- Backfill, so an existing install is correct the moment it boots. Same
-- transaction as the triggers above, so no visit can land between the two.
INSERT INTO "visit_days" ("day", "domain_id", "link_id", "dimension", "value", "is_bot", "count")
SELECT
  (v."occurred_at" AT TIME ZONE 'UTC')::date,
  v."domain_id",
  v."link_id",
  dims.dim,
  dims.val,
  v."is_bot",
  count(*)
FROM "visits" v
CROSS JOIN LATERAL (VALUES
  ('total'::visit_dimension,  ''::text),
  ('country'::visit_dimension,      coalesce(v."country", '')::text),
  ('region'::visit_dimension,       coalesce(v."region", '')::text),
  ('platform'::visit_dimension,     v."platform"::text),
  ('referer'::visit_dimension,      coalesce(v."referer", '')::text),
  ('destination'::visit_dimension,  coalesce(v."destination", '')::text),
  ('slug'::visit_dimension,         v."slug_requested"::text)
) AS dims(dim, val)
GROUP BY 1, 2, 3, 4, 5, 6;
--> statement-breakpoint
INSERT INTO "visit_counts" ("domain_id", "link_id", "human", "bot", "last_visit_at")
SELECT
  "domain_id",
  "link_id",
  count(*) FILTER (WHERE NOT "is_bot"),
  count(*) FILTER (WHERE "is_bot"),
  max("occurred_at")
FROM "visits"
GROUP BY "domain_id", "link_id";
