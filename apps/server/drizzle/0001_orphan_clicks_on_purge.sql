ALTER TABLE "clicks" DROP CONSTRAINT "clicks_linq_id_linqs_id_fk";
--> statement-breakpoint
ALTER TABLE "clicks" ADD CONSTRAINT "clicks_linq_id_linqs_id_fk" FOREIGN KEY ("linq_id") REFERENCES "public"."linqs"("id") ON DELETE set null ON UPDATE no action;