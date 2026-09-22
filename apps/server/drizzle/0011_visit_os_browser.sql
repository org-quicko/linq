-- Captures what platform's three-way enum never could: the actual OS and
-- browser, parsed from the same user_agent already being stored. See
-- docs/plans/Plan_20.md.
--
-- No backfill: existing rows keep null for both, same call 0010 made for its
-- own column change — only a future visit is affected. (Unlike a dropped
-- geolocation column, user_agent is still on every existing row, so a
-- backfill *is* possible later if the value of it ever justifies a full
-- table rewrite; it just isn't done here.)
ALTER TABLE "visits" ADD COLUMN "os" text;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "browser" text;
