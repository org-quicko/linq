import { describe, expect, test } from "bun:test"
import { bootstrap } from "../src/bootstrap.ts"
import { claimsForPreset } from "@linq/shared"
import { apiKeys, domains } from "../src/db/schema.ts"
import { createTestDb, testConfig } from "./helpers/db.ts"

describe("bootstrap", () => {
  test("mints one admin key on an empty database", async () => {
    const db = await createTestDb()
    await bootstrap(db, testConfig)

    const keys = await db.select().from(apiKeys)
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatchObject({
      name: "bootstrap",
      claims: [...claimsForPreset.admin],
      expires_at: null,
    })
    // Only the hash is kept, and the prefix is the readable half of the secret.
    expect(keys[0]?.key_hash).toHaveLength(64)
    expect(keys[0]?.prefix).toStartWith("linq_")
  })

  test("is idempotent: a second boot adds nothing", async () => {
    const db = await createTestDb()
    const config = { ...testConfig, LINQ_DEFAULT_DOMAIN: "linq.test" }
    await bootstrap(db, config)
    await bootstrap(db, config)

    expect(await db.select().from(apiKeys)).toHaveLength(1)
    expect(await db.select().from(domains)).toHaveLength(1)
  })

  /**
   * The guard is "no keys", not "never booted": an instance whose last key was
   * revoked mints itself a way back in rather than becoming unreachable.
   */
  test("mints again once every key is gone", async () => {
    const db = await createTestDb()
    await bootstrap(db, testConfig)
    const [first] = await db.select().from(apiKeys)

    await db.delete(apiKeys)
    await bootstrap(db, testConfig)

    const [second] = await db.select().from(apiKeys)
    expect(second).toBeDefined()
    expect(second?.id).not.toBe(first?.id)
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
