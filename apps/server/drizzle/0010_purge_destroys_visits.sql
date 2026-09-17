-- Link purge now destroys that link's visit data instead of reclassifying it
-- as orphan traffic. Purging used to fall `visits.link_id` back to NULL and
-- merge the link's rollup rows into the domain's orphan totals — both made an
-- active link's own traffic look like orphan traffic. See docs/adr/0007: the
-- rollups are always supposed to equal a live aggregate over `visits`, so raw
-- visits and rollups have to be destroyed together. Genuine orphan visits — a
-- request that resolved to no active link at insert time — are untouched:
-- they still insert with `link_id` NULL and still roll up as orphan traffic.
--
-- No backfill: this only changes what happens to rows deleted by a *future*
-- purge, so nothing already stored needs migrating.
--
-- Order matters only in that Postgres has no `ALTER ... ON DELETE`: the FK's
-- action is swapped by dropping and re-adding the constraint.
ALTER TABLE "visits" DROP CONSTRAINT "visits_link_id_links_id_fk";
--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_link_id_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."links"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Deletes the purged link's rollup rows instead of merging them into the
-- domain's orphan scope. Function name kept as `orphan_visit_rollups` — the
-- same low-diff move 0006_drop_geolocation.sql made for `record_visit_rollup`
-- when its dimensions changed underneath it. The trigger name,
-- `links_purge_rollup`, stays accurate either way.
CREATE OR REPLACE FUNCTION orphan_visit_rollups() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "visit_days" WHERE "link_id" = old.id;
  DELETE FROM "visit_counts" WHERE "link_id" = old.id;

  RETURN NULL;
END $$;
