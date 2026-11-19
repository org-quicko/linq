import pkg from "../package.json" with { type: "json" }
import { CacheAdapter } from "./adapters/index.ts"
import { createApp } from "./app.ts"
import { bootstrap } from "./bootstrap.ts"
import { CaddyClient, DbClient, LinkMetadataClient } from "./clients/index.ts"
import { loadConfig } from "./config.ts"
import { runMigrations } from "./db/migrate.ts"
import { Logger } from "./libs/index.ts"
import { VisitPipeline } from "./telemetry/index.ts"

const config = loadConfig()
// Before anything else logs: the logger is silent until this runs.
await Logger.init(config)

const db = DbClient.start(config)

await runMigrations(db, { advisoryLock: true, schema: config.LINQ_DB_SCHEMA })
await bootstrap(db, config)

const cache = await CacheAdapter.start(config)
const caddy = CaddyClient.start(config)
const visitPipeline = new VisitPipeline(db, config)
const { app, domainService } = createApp({
  db,
  config,
  visitPipeline,
  cache,
  caddy,
  metadata: LinkMetadataClient.start(config),
})

// Repairs Caddy's routes after its own restart, or a first boot alongside a
// fresh Caddy container whose skeleton config has no routes yet. The app's
// Caddy is guarded, so an unreachable Caddy never stops the boot.
await domainService.reconcileCaddy()

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
