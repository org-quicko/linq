import { DbClient } from "../clients/index.ts"
import { loadConfig } from "../config.ts"
import { runMigrations } from "../db/migrate.ts"

const config = loadConfig()
const db = DbClient.start(config)
try {
  await runMigrations(db, { advisoryLock: true, schema: config.LINQ_DB_SCHEMA })
} finally {
  await db.destroy()
}
