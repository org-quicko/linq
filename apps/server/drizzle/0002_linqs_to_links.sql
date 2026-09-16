ALTER TABLE "linqs" RENAME TO "links";--> statement-breakpoint
ALTER TABLE "rules" RENAME COLUMN "linq_id" TO "link_id";--> statement-breakpoint
ALTER TABLE "clicks" RENAME COLUMN "linq_id" TO "link_id";--> statement-breakpoint
ALTER TABLE "links" RENAME CONSTRAINT "linqs_domain_id_domains_id_fk" TO "links_domain_id_domains_id_fk";--> statement-breakpoint
ALTER TABLE "links" RENAME CONSTRAINT "linqs_owner_id_users_id_fk" TO "links_owner_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "rules" RENAME CONSTRAINT "rules_linq_id_linqs_id_fk" TO "rules_link_id_links_id_fk";--> statement-breakpoint
ALTER TABLE "clicks" RENAME CONSTRAINT "clicks_linq_id_linqs_id_fk" TO "clicks_link_id_links_id_fk";--> statement-breakpoint
ALTER INDEX "linqs_pkey" RENAME TO "links_pkey";--> statement-breakpoint
ALTER INDEX "linqs_domain_slug_key" RENAME TO "links_domain_slug_key";--> statement-breakpoint
ALTER INDEX "linqs_owner_id_idx" RENAME TO "links_owner_id_idx";--> statement-breakpoint
ALTER INDEX "linqs_status_idx" RENAME TO "links_status_idx";--> statement-breakpoint
ALTER INDEX "linqs_tags_idx" RENAME TO "links_tags_idx";--> statement-breakpoint
ALTER INDEX "rules_linq_position_key" RENAME TO "rules_link_position_key";--> statement-breakpoint
ALTER INDEX "clicks_linq_occurred_idx" RENAME TO "clicks_link_occurred_idx";
