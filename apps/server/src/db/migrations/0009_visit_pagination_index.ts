import { type Kysely, sql } from "kysely"

/**
 * Supports the global visit log's stable ordering. Domain/link indexes cannot
 * serve an unscoped page. VisitService pages IDs before loading full rows.
 * Built transactionally at boot; on an existing large database, allow time for
 * the index build before accepting traffic. No visit rows are rewritten.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX visits_visited_id_idx ON visits (visited_at DESC, id DESC)`.execute(db)
}
