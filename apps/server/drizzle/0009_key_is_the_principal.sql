-- The API key becomes the principal: there are no user rows, so a key carries
-- its own name and role, and a link is owned by the key that created it.
-- See docs/adr/0011.
--
-- THIS DISCARDS EVERY EXISTING KEY AND EVERY LINK'S OWNERSHIP. A key's role
-- lived on its user, and which of a user's several keys should inherit its
-- links has no honest answer — so rather than guess, both are dropped. Links,
-- domains, rules and visits are untouched; the links simply become unowned.
-- Mint a replacement with `bun run key:create`. Nothing has shipped, so this
-- is a cleanup rather than a loss.
--
-- Order matters: `links.owner_id` is NOT NULL today, so the constraint has to
-- go before the column can be emptied.
ALTER TABLE "links" DROP CONSTRAINT "links_owner_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "links" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
UPDATE "links" SET "owner_id" = NULL;--> statement-breakpoint
DELETE FROM "api_keys";--> statement-breakpoint

-- api_keys becomes the principal. `role` can be NOT NULL with no default only
-- because the table was just emptied.
ALTER TABLE "api_keys" RENAME COLUMN "label" TO "name";--> statement-breakpoint
DROP INDEX "api_keys_user_id_idx";--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "role" "public"."role" NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint

-- Ownership repoints at the key. ON DELETE SET NULL, so revoking a leaked key
-- always succeeds instead of being held hostage by the links it owns.
ALTER TABLE "links" ADD CONSTRAINT "links_owner_id_api_keys_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

DROP TABLE "users";--> statement-breakpoint
DROP TYPE "public"."user_status";
