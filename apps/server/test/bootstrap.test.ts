import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { hashKey } from "../src/auth/keys.ts"
import { bootstrap } from "../src/bootstrap.ts"
import { apiKeys, domains, users } from "../src/db/schema.ts"
import { createTestDb, testConfig } from "./helpers/db.ts"

describe("bootstrap", () => {
  test("mints one admin and its key on an empty database", async () => {
    const db = await createTestDb()
    await bootstrap(db, { ...testConfig, LINQ_INITIAL_API_KEY: "linq_seeded_key_value" })

    const [admin] = await db.select().from(users)
    expect(admin).toMatchObject({ name: "admin", role: "admin", status: "active" })

    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.userId, admin.id))
    expect(key.keyHash).toBe(hashKey("linq_seeded_key_value"))
    expect(key.prefix).toBe("linq_seeded_")
  })

  test("generates a key when none is configured", async () => {
    const db = await createTestDb()
    await bootstrap(db, testConfig)
    expect(await db.select().from(apiKeys)).toHaveLength(1)
  })

  test("is idempotent: a second boot adds nothing", async () => {
    const db = await createTestDb()
    const config = { ...testConfig, LINQ_DEFAULT_DOMAIN: "linq.test" }
    await bootstrap(db, config)
    await bootstrap(db, config)

    expect(await db.select().from(users)).toHaveLength(1)
    expect(await db.select().from(apiKeys)).toHaveLength(1)
    expect(await db.select().from(domains)).toHaveLength(1)
  })

  test("seeds the default domain lowercased, and only when configured", async () => {
    const seeded = await createTestDb()
    await bootstrap(seeded, { ...testConfig, LINQ_DEFAULT_DOMAIN: "Links.Example.COM" })
    expect((await seeded.select().from(domains))[0]).toMatchObject({
      host: "links.example.com",
      status: "active",
    })

    const bare = await createTestDb()
    await bootstrap(bare, testConfig)
    expect(await bare.select().from(domains)).toHaveLength(0)
  })
})
