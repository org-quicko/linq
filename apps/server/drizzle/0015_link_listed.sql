-- Opt-in publication for /llms.txt: default false, so nothing is exposed to
-- the new unauthenticated surface until a link chooses it. The partial index
-- serves that route; it stays tiny because it only ever holds opt-in rows.
-- See plans/Plan_25.md.
ALTER TABLE "links" ADD COLUMN "listed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "links_listed_idx" ON "links" USING btree ("domain_id") WHERE "links"."listed";