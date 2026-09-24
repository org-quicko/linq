import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { sql } from "kysely"
import { FileMigrationProvider, Migrator } from "kysely/migration"
import { span } from "../log.ts"
import type { Db } from "./client.ts"

/** Absolute path to the ordered Kysely migrations, resolved relative to this file. */
export const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
)

function migrationLockKey(schema: string): number {
  return createHash("sha256").update(`linq:migrations:${schema}`).digest().readInt32BE(0)
}

/** Applies every pending migration. Runs at startup, before anything reads. */
export async function runMigrations(
  db: Db,
  options: { advisoryLock?: boolean; schema?: string } = {},
): Promise<void> {
  const schema = options.schema ?? "public"
  // One pinned connection: a session advisory lock must be released on the
  // pooled connection that took it, or it leaks and blocks the next instance.
  await span("db.migrate", () =>
    db.connection().execute(async (conn) => {
      if (options.advisoryLock)
        await sql`select pg_advisory_lock(${migrationLockKey(schema)})`.execute(conn)
      try {
        await conn.schema.createSchema(schema).ifNotExists().execute()
        const migrator = new Migrator({
          db: conn,
          provider: new FileMigrationProvider({ fs, path, migrationFolder: migrationsFolder }),
          migrationTableName: "linq_kysely_migration",
          migrationLockTableName: "linq_kysely_migration_lock",
        })
        const result = await migrator.migrateToLatest()
        if (result.error) throw result.error
      } finally {
        if (options.advisoryLock)
          await sql`select pg_advisory_unlock(${migrationLockKey(schema)})`.execute(conn)
      }
    }),
  )
}
