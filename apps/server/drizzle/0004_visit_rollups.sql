CREATE TYPE "public"."visit_dimension" AS ENUM('total', 'country', 'region', 'platform', 'referer', 'destination', 'slug');--> statement-breakpoint
CREATE TABLE "visit_counts" (
	"domain_id" uuid NOT NULL,
	"link_id" uuid,
	"human" bigint DEFAULT 0 NOT NULL,
	"bot" bigint DEFAULT 0 NOT NULL,
	"last_visit_at" timestamp with time zone,
	CONSTRAINT "visit_counts_key" UNIQUE NULLS NOT DISTINCT("domain_id","link_id")
);
--> statement-breakpoint
CREATE TABLE "visit_days" (
	"day" date NOT NULL,
	"domain_id" uuid NOT NULL,
	"link_id" uuid,
	"dimension" "visit_dimension" NOT NULL,
	"value" text NOT NULL,
	"is_bot" boolean NOT NULL,
	"count" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "visit_days_key" UNIQUE NULLS NOT DISTINCT("day","domain_id","link_id","dimension","value","is_bot")
);
--> statement-breakpoint
ALTER TABLE "visit_counts" ADD CONSTRAINT "visit_counts_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_days" ADD CONSTRAINT "visit_days_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "visit_counts_link_idx" ON "visit_counts" USING btree ("link_id");--> statement-breakpoint
CREATE INDEX "visit_days_link_idx" ON "visit_days" USING btree ("link_id","dimension","day");--> statement-breakpoint
CREATE INDEX "visit_days_domain_idx" ON "visit_days" USING btree ("domain_id","dimension","day");