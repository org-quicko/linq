import { claimsForPreset } from "@linq/shared"
import type { Config } from "./config.ts"
import { type Db, log, span } from "./libs/index.ts"
import { createApiKey } from "./services/index.ts"

/**
 * First-boot setup. Both steps are skipped once their table has any row, so
 * restarting never mints a second key or resurrects a deleted domain.
 */
export async function bootstrap(db: Db, config: Config): Promise<void> {
  await span("bootstrap", async () => {
    // Mints an admin key while the instance has none, and prints it once. The
    // guard is "no keys", not "first ever boot", so an instance whose last key
    // was revoked mints itself a way back in on the next restart rather than
    // becoming permanently unreachable. `bun run key:create` is the way in that
    // does not need a restart. See resources/docs/adr/0011.
    await span("bootstrap.key", async () => {
      const existingKey = await db.selectFrom("api_keys").select("id").limit(1).executeTakeFirst()
      if (existingKey) return

      const { row, secret } = await createApiKey(db, {
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
      log.warn({ keyId: row.id }, "bootstrap: admin key minted, printed to stdout")
    })

    // Inserts LINQ_DEFAULT_DOMAIN as the first domain, but only while the table
    // is empty, so an operator who later archives or replaces it is not
    // overruled on the next restart.
    await span("bootstrap.defaultDomain", async () => {
      if (!config.LINQ_DEFAULT_DOMAIN) return
      const existingDomain = await db.selectFrom("domains").select("id").limit(1).executeTakeFirst()
      if (existingDomain) return

      const host = config.LINQ_DEFAULT_DOMAIN.replace(/^https?:\/\//i, "").toLowerCase()
      await db
        .insertInto("domains")
        .values({ id: Bun.randomUUIDv7(), host, status: "active" })
        .execute()
      log.info({ host }, "bootstrap: seeded default domain")
    })
  })
}
