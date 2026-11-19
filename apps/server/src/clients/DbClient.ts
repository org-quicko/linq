import { Kysely, PostgresDialect } from "kysely"
import { Pool, types } from "pg"
import type { Config } from "../config.ts"
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
 * Opens the Postgres handle. A static factory rather than a class around
 * Kysely: `Db` has to stay a plain Kysely instance, because a transaction
 * (`tx`) and the tests' PGlite handle are plain Kysely too, and every service
 * and `RuleService(tx)` takes either.
 */
export class DbClient {
  /**
   * Opens the production handle, bound to the configured schema. Release it with `db.destroy()`.
   *
   * Every session runs in UTC, whatever the server's own `timezone` setting is
   * (RDS and Aurora default to UTC; a local install often inherits the OS zone).
   * linq's days are UTC days, so any implicit date/timestamptz conversion in a
   * query must agree with them.
   *
   * @param config - DATABASE_URL and LINQ_DB_SCHEMA.
   * @returns The handle.
   */
  static start(config: Pick<Config, "DATABASE_URL" | "LINQ_DB_SCHEMA">): Db {
    return new Kysely<DB>({
      dialect: new PostgresDialect({
        pool: new Pool({
          connectionString: config.DATABASE_URL,
          options: `-c search_path=${config.LINQ_DB_SCHEMA},public -c TimeZone=UTC`,
        }),
      }),
    })
  }
}
