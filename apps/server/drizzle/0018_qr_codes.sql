-- QR codes for short links. The encoded data is not stored: it is always the
-- link's current short URL, so renaming a domain re-points every printed code.
-- Only the styling lives here. See plans/Plan_31.md.
CREATE TYPE "public"."qr_pattern" AS ENUM('squares', 'rounded', 'dots');--> statement-breakpoint
CREATE TABLE "qr_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"link_id" uuid NOT NULL,
	"name" text,
	"dot_color" text DEFAULT '#000000' NOT NULL,
	"bg_color" text DEFAULT '#ffffff' NOT NULL,
	"pattern" "qr_pattern" DEFAULT 'squares' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_link_id_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "qr_codes_link_id_idx" ON "qr_codes" USING btree ("link_id");
