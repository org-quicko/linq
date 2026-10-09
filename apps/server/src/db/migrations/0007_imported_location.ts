import { type Kysely, sql } from "kysely"

/**
 * Gives imported visits somewhere to keep a location that was resolved before
 * they reached linq. See resources/docs/adr/0021.
 *
 * linq does not capture these yet: there is no lookup, and a visit it records
 * leaves both null. Plain nullable columns with no index, rollup dimension or
 * trigger change, so adding them is a catalog-only change with no table rewrite.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE visits ADD COLUMN country text, ADD COLUMN region text`.execute(db)
}
