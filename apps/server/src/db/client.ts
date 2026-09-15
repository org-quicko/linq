import { drizzle } from "drizzle-orm/bun-sql"
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import { schema } from "./schema.ts"

/**
 * Driver-agnostic handle. Production uses Bun's built-in Postgres client; the
 * test suite passes a PGlite-backed instance with the same schema.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>

/** Opens the production handle: Bun's built-in Postgres client bound to this schema. */
export function createDb(url: string): Db {
  return drizzle(url, { schema }) as unknown as Db
}
