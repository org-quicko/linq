import { type Caddy, claimsForPreset } from "@linq/shared"
import { type Db, GuardedCaddy, NoopCaddyClient } from "./clients/index.ts"
import type { Config } from "./config.ts"
import { Logger } from "./libs/index.ts"
import { ApiKeyService } from "./services/index.ts"

/**
 * Boot-time setup, run once before `createApp`. The first two steps are
 * first-boot only: each is skipped once its table has any row, so restarting
 * never mints a second key or resurrects a deleted domain. The last, the Caddy
 * reconcile, runs on every boot.
 *
 * @param db - The database.
 * @param config - LINQ_DEFAULT_DOMAIN and LINQ_APP_HOST.
 * @param caddy - Caddy's admin API, or its no-op when Caddy sync is off. Guarded here,
 *   so an unreachable Caddy never stops the boot.
 */
export async function bootstrap(
  db: Db,
  config: Config,
  caddy: Caddy = new NoopCaddyClient(),
): Promise<void> {
  await Logger.operation("bootstrap", async () => {
    // Mints an admin key while the instance has none, and prints it once. The
    // guard is "no keys", not "first ever boot", so an instance whose last key
    // was revoked mints itself a way back in on the next restart rather than
    // becoming permanently unreachable. `bun run key:create` is the way in that
    // does not need a restart. See resources/docs/adr/0011.
    await Logger.operation("bootstrap.key", async () => {
      const existingKey = await db.selectFrom("api_keys").select("id").limit(1).executeTakeFirst()
      if (existingKey) return

      // Boot runs before `createApp`, once, so it builds its own service.
      const { row, secret } = await new ApiKeyService(db).create({
        name: "Bootstrap Key",
        claims: claimsForPreset.admin,
      })

      // Stays on console: a plaintext admin key in a rotating file on a mounted
      // volume is strictly worse than one line in the operator's terminal.
      console.log(`
  linq admin API key: ${secret}
  Store it now; it is not recoverable.
  Create more with: bun run key:create --name <name> --preset <preset>
`)
      // The log records only that a key was minted, never the key.
      Logger.warn({ keyId: row.id }, "bootstrap: admin key minted, printed to stdout")
    })

    // Inserts LINQ_DEFAULT_DOMAIN as the first domain, but only while the table
    // is empty, so an operator who later archives or replaces it is not
    // overruled on the next restart.
    await Logger.operation("bootstrap.defaultDomain", async () => {
      if (!config.LINQ_DEFAULT_DOMAIN) return
      const existingDomain = await db.selectFrom("domains").select("id").limit(1).executeTakeFirst()
      if (existingDomain) return

      const host = config.LINQ_DEFAULT_DOMAIN.replace(/^https?:\/\//i, "").toLowerCase()
      await db
        .insertInto("domains")
        .values({ id: Bun.randomUUIDv7(), host, status: "active" })
        .execute()
      Logger.info({ host }, "bootstrap: seeded default domain")
    })

    // Repairs Caddy's routes after Caddy's own restart wipes it back to its
    // empty skeleton, or on a first boot alongside a fresh Caddy container. The
    // only place every active domain is read at once: a boot-time cost, paid
    // once, never per-request. After the default-domain seed, so a fresh install
    // gets its route on this boot. LINQ_APP_HOST is no domain row, so it gets
    // its own fixed route; changing it takes a restart.
    await Logger.operation("bootstrap.reconcileCaddy", async () => {
      const safeCaddy = new GuardedCaddy(caddy)
      const rows = await db
        .selectFrom("domains")
        .select(["id", "host"])
        .where("status", "=", "active")
        .execute()
      for (const row of rows) await safeCaddy.upsert(row.id, row.host)
      if (config.LINQ_APP_HOST) await safeCaddy.upsert("app-host", config.LINQ_APP_HOST)
    })
  })
}
