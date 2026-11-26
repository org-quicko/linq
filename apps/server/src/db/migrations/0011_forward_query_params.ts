import { type Kysely, sql } from "kysely"

/**
 * Renames `links.forward_query` to `forward_query_params`, matching the API
 * field. A rename only touches the catalogue, so no row is rewritten. Redirect
 * entries cached under the old field name are never read again: the cache keys
 * changed in the same release, so they simply expire.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE links RENAME COLUMN forward_query TO forward_query_params`.execute(db)
}
