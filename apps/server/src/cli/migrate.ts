import { loadConfig } from "../infra/config.ts"
import { createDb, destroyDb } from "../infra/db/client.ts"
import { runMigrations } from "../infra/db/migrate.ts"

const config = loadConfig()
const db = createDb(config.DATABASE_URL, config.LINQ_DB_SCHEMA)
try {
  await runMigrations(db, { advisoryLock: true, schema: config.LINQ_DB_SCHEMA })
} finally {
  await destroyDb(db)
}
