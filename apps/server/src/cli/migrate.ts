import { loadConfig } from "../config.ts"
import { runMigrations } from "../db/migrate.ts"
import { createDb } from "../libs/index.ts"

const config = loadConfig()
const db = createDb(config.DATABASE_URL, config.LINQ_DB_SCHEMA)
try {
  await runMigrations(db, { advisoryLock: true, schema: config.LINQ_DB_SCHEMA })
} finally {
  await db.destroy()
}
