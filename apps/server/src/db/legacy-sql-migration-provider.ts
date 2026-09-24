import { readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { sql } from "kysely"
import type { Kysely } from "kysely"
import type { Migration, MigrationProvider } from "kysely/migration"

/**
 * Executes the immutable SQL history that created the currently deployed
 * schema. Kysely records execution; Drizzle is not loaded at runtime.
 */
export class LegacySqlMigrationProvider implements MigrationProvider {
  constructor(private readonly migrationFolder: string) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await readdir(this.migrationFolder))
      .filter((file) => /^\d{4}_.+\.sql$/.test(file))
      .sort()

    const migrations = await Promise.all(
      files.map(async (file) => {
        const source = await readFile(join(this.migrationFolder, file), "utf8")
        const statements = source
          .split("--> statement-breakpoint")
          .map((statement) => statement.trim())
          .filter(Boolean)

        return [
          basename(file, ".sql"),
          {
            up: async (db: Kysely<any>) => {
              for (const statement of statements) await sql.raw(statement).execute(db)
            },
          },
        ] as const
      }),
    )

    return Object.fromEntries(migrations)
  }
}
