import pkg from "../package.json" with { type: "json" }
import { bootstrap } from "./bootstrap.ts"
import { startCache } from "./cache.ts"
import { loadConfig } from "./config.ts"
import { createDb } from "./db/client.ts"
import { runMigrations } from "./db/migrate.ts"
import { createApp } from "./http/app.ts"
import { flushLogs, initLogger, log } from "./log.ts"
import { flushVisits } from "./visits/record.ts"

const config = loadConfig()
// Before anything else logs: the logger is silent until this runs.
await initLogger(config)

const db = createDb(config.DATABASE_URL)

await runMigrations(db)
await bootstrap(db, config)

const cache = await startCache(config)
const app = createApp({ db, config, cache })

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
  process.exit(0)
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))
