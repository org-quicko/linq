-- A link's title/description/favicon can now be filled from the destination's
-- own <head> when the caller doesn't supply them. See docs/adr/0014.
ALTER TABLE "links" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "links" ADD COLUMN "icon_url" text;