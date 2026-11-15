import pkg from "../package.json" with { type: "json" }
import { createApp } from "./app.ts"
import { bootstrap } from "./bootstrap.ts"
import { loadConfig } from "./config.ts"
import { runMigrations } from "./db/migrate.ts"
import {
  createDb,
  flushLogs,
  guardedCaddy,
  initLogger,
  log,
  startCache,
  startCaddy,
  startMetadata,
} from "./libs/index.ts"
import { flushVisits, reconcileCaddy } from "./services/index.ts"

const config = loadConfig()
// Before anything else logs: the logger is silent until this runs.
await initLogger(config)

const db = createDb(config.DATABASE_URL, config.LINQ_DB_SCHEMA)

await runMigrations(db, { advisoryLock: true, schema: config.LINQ_DB_SCHEMA })
await bootstrap(db, config)

const cache = await startCache(config)
const caddy = startCaddy(config)
const app = createApp({ db, config, cache, caddy, metadata: startMetadata(config) })

// Repairs Caddy's routes after its own restart, or a first boot alongside a
// fresh Caddy container whose skeleton config has no routes yet. Guarded so an
// unreachable Caddy never stops the boot.
await reconcileCaddy(db, guardedCaddy(caddy), config.LINQ_APP_HOST)

const server = Bun.serve({
  port: config.LINQ_PORT,
  fetch: app.fetch,
})
log.info({ port: config.LINQ_PORT, version: pkg.version }, "linq listening")

/**
 * Visits are inserted fire-and-forget and log writes are buffered, so both are
 * drained before exit or `docker stop` silently loses the last of each.
 */
async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "shutting down")
  await server.stop()
  await flushVisits()
  cache.stop()
  await flushLogs()
  await db.destroy()
  process.exit(0)
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))
