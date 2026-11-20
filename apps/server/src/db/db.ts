import { Kysely, PostgresDialect } from "kysely"
import { Pool, types } from "pg"
import { loadConfig } from "../config.ts"
import type { DB } from "./types.generated.ts"

/** Services accept this handle or a transaction; tests supply isolated PGlite handles. */
export type Db = Kysely<DB>

// Aggregate counts are numbers in the API contract, including PostgreSQL bigint.
types.setTypeParser(20, Number)

const config = loadConfig()

/**
 * The process's PostgreSQL instance. Import from entry points after environment
 * setup; type-only imports do not initialize it. Pool connections open on first
 * use and stay in UTC and the configured schema. Drain with `db.destroy()`.
 */
export const db: Db = new Kysely<DB>({
  dialect: new PostgresDialect({
    pool: new Pool({
      connectionString: config.DATABASE_URL,
      options: `-c search_path=${config.LINQ_DB_SCHEMA},public -c TimeZone=UTC`,
    }),
  }),
})
