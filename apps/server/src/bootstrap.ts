import { createApiKey } from "./auth/mint.ts"
import type { Config } from "./config.ts"
import type { Db } from "./db/client.ts"
import { apiKeys, domains } from "./db/schema.ts"
import { log, span } from "./log.ts"

/**
 * First-boot setup. Both steps are skipped once their table has any row, so
 * restarting never mints a second key or resurrects a deleted domain.
 */
export async function bootstrap(db: Db, config: Config): Promise<void> {
  await span("bootstrap", async () => {
    await bootstrapKey(db)
    await seedDefaultDomain(db, config)
  })
}

/**
 * Mints an admin key while the instance has none, and prints it once.
 *
 * The guard is "no keys", not "first ever boot", so an instance whose last key
 * was revoked mints itself a way back in on the next restart rather than
 * becoming permanently unreachable. `bun run key:create` is the way in that
 * does not need a restart. See docs/adr/0011.
 */
async function bootstrapKey(db: Db): Promise<void> {
  await span("bootstrap.key", async () => {
    const [existing] = await db.select({ id: apiKeys.id }).from(apiKeys).limit(1)
    if (existing) return

    const { row, secret } = await createApiKey(db, { name: "bootstrap", role: "admin" })

    // Stays on console: a plaintext admin key in a rotating file on a mounted
    // volume is strictly worse than one line in the operator's terminal.
    console.log(`
  linq admin API key: ${secret}
  Store it now; it is not recoverable.
  Create more with: bun run key:create --name <name> --role <role>
`)
    // The log records only that a key was minted, never the key.
    log.warn({ keyId: row.id }, "bootstrap: admin key minted, printed to stdout")
  })
}

/**
 * Inserts `LINQ_DEFAULT_DOMAIN` as the first domain, but only while the table is
 * empty, so an operator who later archives or replaces it is not overruled on
 * the next restart.
 */
async function seedDefaultDomain(db: Db, config: Config): Promise<void> {
  await span("bootstrap.defaultDomain", async () => {
    if (!config.LINQ_DEFAULT_DOMAIN) return
    const [existing] = await db.select({ id: domains.id }).from(domains).limit(1)
    if (existing) return

    const host = config.LINQ_DEFAULT_DOMAIN.toLowerCase()
    await db.insert(domains).values({ id: Bun.randomUUIDv7(), host })
    log.info({ host }, "bootstrap: seeded default domain")
  })
}
