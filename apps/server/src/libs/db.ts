import { Kysely, PostgresDialect } from "kysely"
import { Pool, types } from "pg"
import type { DB } from "../db/types.generated.ts"

/**
 * Driver-agnostic handle. Production uses node-postgres; the test suite passes
 * a PGlite-backed instance with the same schema.
 */
export type Db = Kysely<DB>

// linq's API has always exposed aggregate counts as JavaScript numbers. Keep
// that contract when moving from Bun SQL to node-postgres.
types.setTypeParser(20, Number)

/**
 * Opens the production handle, bound to this schema. Release it with `db.destroy()`.
 *
 * Every session runs in UTC, whatever the server's own `timezone` setting is
 * (RDS and Aurora default to UTC; a local install often inherits the OS zone).
 * linq's days are UTC days, so any implicit date/timestamptz conversion in a
 * query must agree with them.
 */
export function createDb(url: string, schema = "public"): Db {
  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: url,
        options: `-c search_path=${schema},public -c TimeZone=UTC`,
      }),
    }),
  })
}
