import pkg from "../package.json" with { type: "json" }
import { bootstrap } from "./bootstrap.ts"
import { startCache } from "./cache.ts"
import { guarded as guardedCaddy, reconcileCaddy, startCaddy } from "./caddy.ts"
import { loadConfig } from "./config.ts"
import { createDb, destroyDb } from "./db/client.ts"
import { runMigrations } from "./db/migrate.ts"
import { createApp } from "./http/app.ts"
import { guarded as guardedMetadata, startMetadata } from "./link-metadata.ts"
import { flushLogs, initLogger, log } from "./log.ts"
import { flushVisits } from "./visits/record.ts"

const config = loadConfig()
// Before anything else logs: the logger is silent until this runs.
await initLogger(config)

const db = createDb(config.DATABASE_URL, config.LINQ_DB_SCHEMA)

await runMigrations(db, { advisoryLock: true, schema: config.LINQ_DB_SCHEMA })
await bootstrap(db, config)

const cache = await startCache(config)
const caddy = guardedCaddy(startCaddy(config))
const metadata = guardedMetadata(startMetadata(config))
const app = createApp({ db, config, cache, caddy, metadata })

// Repairs Caddy's routes after its own restart, or a first boot alongside a
// fresh Caddy container whose skeleton config has no routes yet.
await reconcileCaddy(db, caddy, config.LINQ_APP_HOST)

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
  await destroyDb(db)
  process.exit(0)
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))
