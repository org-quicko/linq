import { Pool, types } from "pg"
import { Kysely, PostgresDialect } from "kysely"
import type { DB } from "./types.generated.ts"

/**
 * Driver-agnostic handle. Production uses Bun's built-in Postgres client; the
 * test suite passes a PGlite-backed instance with the same schema.
 */
export type Db = Kysely<DB>

// linq's API has always exposed aggregate counts as JavaScript numbers. Keep
// that contract when moving from Bun SQL to node-postgres.
types.setTypeParser(20, Number)

/** Opens the production handle: Bun's built-in Postgres client bound to this schema. */
export function createDb(url: string, schema = "public"): Db {
  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: url, options: `-c search_path=${schema},public` }),
    }),
  })
}

/** Releases the Postgres pool opened by createDb. */
export async function destroyDb(db: Db): Promise<void> {
  await db.destroy()
}
