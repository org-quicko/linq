import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { migrate } from "drizzle-orm/pglite/migrator"
import type { Config } from "../../src/config.ts"
import type { Db } from "../../src/db/client.ts"
import { migrationsFolder } from "../../src/db/migrate.ts"
import { schema } from "../../src/db/schema.ts"

/**
 * An in-memory Postgres per suite. PGlite runs the same generated migrations as
 * production, so schema drift shows up here rather than at deploy time.
 */
export async function createTestDb(): Promise<Db> {
  const db = drizzle(new PGlite(), { schema })
  await migrate(db, { migrationsFolder })
  return db as unknown as Db
}

export const testConfig: Config = {
  DATABASE_URL: "memory://pglite",
  LINQ_PORT: 3000,
  LINQ_DEFAULT_DOMAIN: undefined,
  LINQ_INITIAL_API_KEY: undefined,
  LINQ_GEO_ENABLED: false,
  LINQ_GEO_DB_PATH: undefined,
  LINQ_GEO_DIR: "./data",
  LINQ_DATA_DIR: "./data",
  LINQ_SLUG_LENGTH: 6,
  LINQ_TRUST_PROXY: true,
  // Silent by default, and no file: `initLogger` is only ever called by main.ts,
  // so a suite that does not opt in writes nothing anywhere.
  LINQ_LOG_LEVEL: "silent",
  LINQ_LOG_FILE: "",
  LINQ_LOG_MAX_SIZE: "20m",
  LINQ_LOG_RETAIN: 5,
}
