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
  // Every harness runs on `noCache` unless a suite asks for a real one, and the
  // only real one a test can open without external services is the memory store.
  LINQ_CACHE_BACKEND: "memory",
  LINQ_REDIS_URL: undefined,
  LINQ_CACHE_TTL: 300,
  LINQ_CACHE_SWEEP_INTERVAL: 60,
  LINQ_CACHE_MAX_ENTRIES: 10_000,
  LINQ_PORT: 3000,
  LINQ_API_RATE_LIMIT_PER_MINUTE: 1_000,
  LINQ_VISIT_MAX_PENDING: 1_000,
  LINQ_CLIENT_BASE_PATH: "/home",
  LINQ_DEFAULT_DOMAIN: undefined,
  LINQ_DATA_DIR: "./data",
  LINQ_SLUG_LENGTH: 6,
  // Silent by default, and no file: `initLogger` is only ever called by main.ts,
  // so a suite that does not opt in writes nothing anywhere.
  LINQ_LOG_LEVEL: "silent",
  LINQ_LOG_FILE: "",
  LINQ_LOG_MAX_SIZE: "20m",
  LINQ_LOG_RETAIN: 5,
  LINQ_CADDY_ADMIN_URL: undefined,
  LINQ_CADDY_UPSTREAM: undefined,
  LINQ_FETCH_LINK_METADATA: "true",
}
