CREATE TYPE "public"."platform" AS ENUM('android', 'ios', 'desktop');--> statement-breakpoint
CREATE TYPE "public"."resource_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('viewer', 'author', 'editor', 'admin');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "clicks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"linq_id" uuid,
	"domain_id" uuid NOT NULL,
	"slug_requested" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_bot" boolean NOT NULL,
	"platform" "platform" NOT NULL,
	"user_agent" text,
	"referer" text,
	"country" char(2),
	"region" text,
	"destination" text,
	"query" jsonb
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" uuid PRIMARY KEY NOT NULL,
	"host" text NOT NULL,
	"fallback_url" text,
	"status" "resource_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domains_host_unique" UNIQUE("host")
);
--> statement-breakpoint
CREATE TABLE "linqs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"domain_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"destination" text NOT NULL,
	"name" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"forward_query" boolean DEFAULT true NOT NULL,
	"status" "resource_status" DEFAULT 'active' NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"linq_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"destination" text NOT NULL,
	"conditions" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"role" "role" NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clicks" ADD CONSTRAINT "clicks_linq_id_linqs_id_fk" FOREIGN KEY ("linq_id") REFERENCES "public"."linqs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clicks" ADD CONSTRAINT "clicks_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linqs" ADD CONSTRAINT "linqs_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linqs" ADD CONSTRAINT "linqs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_linq_id_linqs_id_fk" FOREIGN KEY ("linq_id") REFERENCES "public"."linqs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_user_id_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "clicks_linq_occurred_idx" ON "clicks" USING btree ("linq_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "clicks_domain_occurred_idx" ON "clicks" USING btree ("domain_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "clicks_orphan_occurred_idx" ON "clicks" USING btree ("occurred_at" DESC NULLS LAST) WHERE "clicks"."linq_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "linqs_domain_slug_key" ON "linqs" USING btree ("domain_id","slug");--> statement-breakpoint
CREATE INDEX "linqs_owner_id_idx" ON "linqs" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "linqs_status_idx" ON "linqs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "linqs_tags_idx" ON "linqs" USING gin ("tags");--> statement-breakpoint
CREATE UNIQUE INDEX "rules_linq_position_key" ON "rules" USING btree ("linq_id","position");