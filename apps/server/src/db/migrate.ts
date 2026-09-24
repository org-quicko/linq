import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { sql } from "kysely"
import { Migrator } from "kysely/migration"
import { span } from "../log.ts"
import type { Db } from "./client.ts"
import { LegacySqlMigrationProvider } from "./legacy-sql-migration-provider.ts"

/** Absolute path to the generated migrations, resolved relative to this file. */
export const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle")
const migrationTable = "linq_kysely_migration"
const migrationLockTable = "linq_kysely_migration_lock"
function migrationLockKey(schema: string): number {
  return createHash("sha256").update(`linq:migrations:${schema}`).digest().readInt32BE(0)
}

function migrator(db: Db): Migrator {
  return new Migrator({
    db,
    provider: new LegacySqlMigrationProvider(migrationsFolder),
    migrationTableName: migrationTable,
    migrationLockTableName: migrationLockTable,
  })
}

async function hasLegacyJournal(db: Db, schema: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    select exists (
      select 1 from information_schema.tables
      where table_schema = ${schema} and table_name = '__drizzle_migrations'
    ) as exists
  `.execute(db)
  return result.rows[0]?.exists ?? false
}

async function hasKyselyJournal(db: Db, schema: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    select exists (
      select 1 from information_schema.tables
      where table_schema = ${schema} and table_name = ${migrationTable}
    ) as exists
  `.execute(db)
  return result.rows[0]?.exists ?? false
}

/** Records immutable legacy migrations without replaying their DDL. */
async function adoptLegacyHistory(db: Db, schema: string): Promise<void> {
  if (!(await hasLegacyJournal(db, schema)) || (await hasKyselyJournal(db, schema))) return

  const result = await sql<{ count: number }>`select count(*)::int as count from __drizzle_migrations`.execute(db)
  const legacy = result.rows[0]
  if (!legacy) throw new Error("Cannot read Drizzle migration history")
  const names = Object.keys(await new LegacySqlMigrationProvider(migrationsFolder).getMigrations())
  if (legacy.count !== names.length) {
    throw new Error(
      `Cannot adopt Drizzle migration history: expected ${names.length} entries, found ${legacy.count}. Resolve the database state explicitly.`,
    )
  }

  await sql.raw(`create table if not exists ${migrationTable} (name varchar(255) primary key not null, timestamp varchar(255) not null)`).execute(db)
  for (const name of names) {
    await sql`insert into linq_kysely_migration (name, timestamp) values (${name}, ${new Date().toISOString()})`.execute(db)
  }
}

/** Applies every pending generated migration. Runs at startup, before anything reads. */
export async function runMigrations(
  db: Db,
  options: { advisoryLock?: boolean; schema?: string } = {},
): Promise<void> {
  const schema = options.schema ?? "public"
  await span("db.migrate", async () => {
    if (options.advisoryLock) await sql`select pg_advisory_lock(${migrationLockKey(schema)})`.execute(db)
    try {
      await db.schema.createSchema(schema).ifNotExists().execute()
      await adoptLegacyHistory(db, schema)
      const result = await migrator(db).migrateToLatest()
      if (result.error) throw result.error
    } finally {
      if (options.advisoryLock) await sql`select pg_advisory_unlock(${migrationLockKey(schema)})`.execute(db)
    }
  })
}
