import pkg from "../package.json" with { type: "json" }
import { CacheAdapter, CaddyAdapter, LinkMetadataAdapter } from "./adapters/index.ts"
import { createApp } from "./app.ts"
import { bootstrap } from "./bootstrap.ts"
import { DbClient } from "./clients/index.ts"
import { loadConfig } from "./config.ts"
import { runMigrations } from "./db/migrate.ts"
import { Logger } from "./libs/index.ts"
import { VisitPipeline } from "./telemetry/index.ts"

const config = loadConfig()
// Before anything else logs: the logger is silent until this runs.
await Logger.init(config)

const db = DbClient.start(config)

await runMigrations(db, { advisoryLock: true, schema: config.LINQ_DB_SCHEMA })
const caddy = CaddyAdapter.start(config)
await bootstrap(db, config, caddy)

const cache = await CacheAdapter.start(config)
const visitPipeline = new VisitPipeline(db, config)
const app = createApp({
  db,
  config,
  visitPipeline,
  cache,
  caddy,
  metadata: LinkMetadataAdapter.start(config),
})

const server = Bun.serve({
  port: config.LINQ_PORT,
  fetch: app.fetch,
})
Logger.info({ port: config.LINQ_PORT, version: pkg.version }, "linq listening")

/**
 * Visits are inserted fire-and-forget and log writes are buffered, so both are
 * drained before exit or `docker stop` silently loses the last of each.
 */
async function shutdown(signal: string): Promise<void> {
  Logger.info({ signal }, "shutting down")
  await server.stop()
  await visitPipeline.flush()
  cache.stop()
  await Logger.flush()
  await db.destroy()
  process.exit(0)
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))
