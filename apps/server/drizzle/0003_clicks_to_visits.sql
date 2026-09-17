ALTER TABLE "clicks" RENAME TO "visits";--> statement-breakpoint
ALTER TABLE "visits" RENAME CONSTRAINT "clicks_link_id_links_id_fk" TO "visits_link_id_links_id_fk";--> statement-breakpoint
ALTER TABLE "visits" RENAME CONSTRAINT "clicks_domain_id_domains_id_fk" TO "visits_domain_id_domains_id_fk";--> statement-breakpoint
ALTER INDEX "clicks_pkey" RENAME TO "visits_pkey";--> statement-breakpoint
ALTER INDEX "clicks_link_occurred_idx" RENAME TO "visits_link_occurred_idx";--> statement-breakpoint
ALTER INDEX "clicks_domain_occurred_idx" RENAME TO "visits_domain_occurred_idx";--> statement-breakpoint
ALTER INDEX "clicks_orphan_occurred_idx" RENAME TO "visits_orphan_occurred_idx";
