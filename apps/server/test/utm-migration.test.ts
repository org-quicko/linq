import { expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { Kysely, PGliteDialect, sql } from "kysely"
import { FileMigrationProvider, Migrator } from "kysely/migration"
import { migrationsFolder } from "../src/db/migrate.ts"

// 0004 backfills the utm rollup from visits recorded before it existed.
test("0004 derives utm columns and backfills their rollup rows", async () => {
  const db = new Kysely<unknown>({ dialect: new PGliteDialect({ pglite: new PGlite() }) })
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder: migrationsFolder }),
  })
  expect((await migrator.migrateTo("0003_tag_table")).error).toBeUndefined()

  const domain = "00000000-0000-7000-8000-000000000001"
  await sql`INSERT INTO domains (id, host) VALUES (${domain}, 'm.test')`.execute(db)
  await sql`INSERT INTO visits (id, domain_id, slug_requested, occurred_at, is_bot, platform, query) VALUES
    ('00000000-0000-7000-8000-0000000000a1', ${domain}, 'a', '2026-03-01T10:00:00Z', false, 'desktop', '{"utm_source":["Mail"],"utm_campaign":["q1"]}'),
    ('00000000-0000-7000-8000-0000000000a2', ${domain}, 'a', '2026-03-01T11:00:00Z', false, 'desktop', '{"utm_source":["mail"]}'),
    ('00000000-0000-7000-8000-0000000000a3', ${domain}, 'a', '2026-03-02T10:00:00Z', true, 'desktop', NULL)`.execute(db)

  expect((await migrator.migrateToLatest()).error).toBeUndefined()

  const rollup = async () =>
    (
      await sql<{ day: string; dimension: string; value: string; is_bot: boolean; count: number }>`
        SELECT to_char(day, 'YYYY-MM-DD') AS day, dimension::text, value, is_bot, count::int
        FROM visit_days WHERE dimension::text LIKE 'utm_%'
        ORDER BY dimension, day, value`.execute(db)
    ).rows
  expect(await rollup()).toEqual([
    { day: "2026-03-01", dimension: "utm_campaign", value: "", is_bot: false, count: 1 },
    { day: "2026-03-01", dimension: "utm_campaign", value: "q1", is_bot: false, count: 1 },
    { day: "2026-03-02", dimension: "utm_campaign", value: "", is_bot: true, count: 1 },
    { day: "2026-03-01", dimension: "utm_medium", value: "", is_bot: false, count: 2 },
    { day: "2026-03-02", dimension: "utm_medium", value: "", is_bot: true, count: 1 },
    { day: "2026-03-01", dimension: "utm_source", value: "mail", is_bot: false, count: 2 },
    { day: "2026-03-02", dimension: "utm_source", value: "", is_bot: true, count: 1 },
  ])

  // The replaced trigger keeps counting after the backfill.
  await sql`INSERT INTO visits (id, domain_id, slug_requested, occurred_at, is_bot, platform, query) VALUES
    ('00000000-0000-7000-8000-0000000000a4', ${domain}, 'a', '2026-03-01T12:00:00Z', false, 'desktop', '{"utm_source":["MAIL"]}')`.execute(
    db,
  )
  const source = (await rollup()).find((r) => r.dimension === "utm_source" && r.value === "mail")
  expect(source?.count).toBe(3)
})
