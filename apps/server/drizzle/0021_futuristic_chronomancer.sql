ALTER TABLE "links" DROP CONSTRAINT "links_owner_id_api_keys_id_fk";
--> statement-breakpoint
-- Four roles collapse to three, not a 1:1 rename `ALTER TYPE ... RENAME VALUE`
-- (0007's approach) can express, so the generated drop-and-recreate through
-- text is right here — but on its own it fails: 'author' and 'manager' rows
-- have no home in the new type. Backfill both to 'editor' before casting back.
-- See docs/adr/0016.
ALTER TABLE "api_keys" ALTER COLUMN "role" SET DATA TYPE text;--> statement-breakpoint
UPDATE "api_keys" SET "role" = 'editor' WHERE "role" IN ('author', 'manager');--> statement-breakpoint
DROP TYPE "public"."role";--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('viewer', 'editor', 'admin');--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "role" SET DATA TYPE "public"."role" USING "role"::"public"."role";--> statement-breakpoint
DROP INDEX "links_owner_id_idx";--> statement-breakpoint
ALTER TABLE "links" DROP COLUMN "owner_id";