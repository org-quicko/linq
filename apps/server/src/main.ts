import pkg from "../package.json" with { type: "json" }
import { bootstrap } from "./bootstrap.ts"
import { startGeo } from "./clicks/geo.ts"
import { flushClicks } from "./clicks/record.ts"
import { loadConfig } from "./config.ts"
import { createDb } from "./db/client.ts"
import { runMigrations } from "./db/migrate.ts"
import { createApp } from "./http/app.ts"
import { flushLogs, initLogger, log } from "./log.ts"

const config = loadConfig()
// Before anything else logs: the logger is silent until this runs.
await initLogger(config)

const db = createDb(config.DATABASE_URL)

await runMigrations(db)
await bootstrap(db, config)

const geo = await startGeo(config)
const app = createApp({ db, config, geo })

// The server handle is passed through so the redirect can read the peer address
// when LINQ_TRUST_PROXY is off.
const server = Bun.serve({
  port: config.LINQ_PORT,
  fetch: (req, s) => app.fetch(req, { server: s }),
})
log.info({ port: config.LINQ_PORT, version: pkg.version }, "linq listening")

/**
 * Clicks are inserted fire-and-forget and log writes are buffered, so both are
 * drained before exit or `docker stop` silently loses the last of each.
 */
async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "shutting down")
  await server.stop()
  await flushClicks()
  geo.stop()
  await flushLogs()
  process.exit(0)
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))
