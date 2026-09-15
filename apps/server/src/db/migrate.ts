import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { migrate } from "drizzle-orm/bun-sql/migrator"
import { span } from "../log.ts"
import type { Db } from "./client.ts"

/** Absolute path to the generated migrations, resolved relative to this file. */
export const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle")

/** Applies every pending generated migration. Runs at startup, before anything reads. */
export async function runMigrations(db: Db): Promise<void> {
  await span("db.migrate", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: migrator is typed per-driver
    await migrate(db as any, { migrationsFolder })
  })
}
