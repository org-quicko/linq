import { type Kysely, sql } from "kysely"

/**
 * Records the classifier result. Nullable on purpose: visits recorded before
 * this migration, or by a temporarily rolled-back server, have no
 * classification. `is_bot` remains the backwards-compatible aggregate flag.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TYPE bot_classification AS ENUM (
      'missing_user_agent',
      'isbot_match',
      'pattern_match',
      'unknown'
    )
  `.execute(db)
  await sql`ALTER TABLE visits ADD COLUMN bot_classification bot_classification`.execute(db)
}
