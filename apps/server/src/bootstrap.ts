import { generateKey, hashKey, keyPrefix } from "./auth/keys.ts"
import type { Config } from "./config.ts"
import type { Db } from "./db/client.ts"
import { apiKeys, domains, users } from "./db/schema.ts"
import { log, span } from "./log.ts"

/**
 * First-boot setup. Both steps are skipped once their table has any row, so
 * restarting never mints a second admin or resurrects a deleted domain.
 */
export async function bootstrap(db: Db, config: Config): Promise<void> {
  await span("bootstrap", async () => {
    await bootstrapAdmin(db, config)
    await seedDefaultDomain(db, config)
  })
}

/**
 * Creates the `admin` user and its first key, but only while the users table is
 * empty. The secret is printed once here and is unrecoverable afterwards.
 */
async function bootstrapAdmin(db: Db, config: Config): Promise<void> {
  await span("bootstrap.admin", async () => {
    const [existing] = await db.select({ id: users.id }).from(users).limit(1)
    if (existing) return

    const secret = config.LINQ_INITIAL_API_KEY ?? generateKey()
    const userId = Bun.randomUUIDv7()
    await db.insert(users).values({ id: userId, name: "admin", role: "admin" })
    await db.insert(apiKeys).values({
      id: Bun.randomUUIDv7(),
      userId,
      label: "bootstrap",
      keyHash: hashKey(secret),
      prefix: keyPrefix(secret),
    })

    // Stays on console: a plaintext admin key in a rotating file on a mounted
    // volume is strictly worse than one line in the operator's terminal.
    console.log(`\n  linq admin API key: ${secret}\n  Store it now; it is not recoverable.\n`)
    // The log records only that a key was minted, never the key.
    log.warn({ userId }, "bootstrap: admin created, key printed to stdout")
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
