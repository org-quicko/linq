import { loadConfig } from "../config.ts"
import { db } from "../db/index.ts"
import { runMigrations } from "../db/migrate.ts"

const config = loadConfig()

try {
  await runMigrations(db, { advisoryLock: true, schema: config.LINQ_DB_SCHEMA })
} finally {
  await db.destroy()
}
