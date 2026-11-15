import { expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { Kysely, PGliteDialect, sql } from "kysely"
import { FileMigrationProvider, Migrator } from "kysely/migration"
import { migrationsFolder } from "../src/db/migrate.ts"

// 0008 only renames, so rows written under 0007 must come through unchanged,
// and the replaced trigger must still roll up a visit inserted afterwards.
test("0008 renames visit columns without losing data and keeps the rollup trigger working", async () => {
  const db = new Kysely<unknown>({ dialect: new PGliteDialect({ pglite: new PGlite() }) })
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder: migrationsFolder }),
  })
  expect((await migrator.migrateTo("0007_imported_location")).error).toBeUndefined()

  const domain = "00000000-0000-7000-8000-000000000001"
  await sql`INSERT INTO domains (id, host) VALUES (${domain}, 'r.test')`.execute(db)
  await sql`INSERT INTO visits (id, domain_id, slug_requested, occurred_at, is_bot, bot_classification, platform, query) VALUES
    ('00000000-0000-7000-8000-0000000000a1', ${domain}, 'a', '2026-03-01T10:00:00Z', true, 'isbot_match', 'desktop',
     '{"utm_source": ["News"]}'::jsonb)`.execute(db)

  expect((await migrator.migrateToLatest()).error).toBeUndefined()

  const { rows } = await sql<{
    visited_at: Date
    bot_classification_reason: string
    query_params: Record<string, string[]>
    utm_source: string
  }>`SELECT visited_at, bot_classification_reason, query_params, utm_source FROM visits`.execute(db)
  expect(rows).toEqual([
    {
      visited_at: new Date("2026-03-01T10:00:00Z"),
      bot_classification_reason: "isbot_match",
      query_params: { utm_source: ["News"] },
      // Still generated from the renamed column.
      utm_source: "news",
    },
  ])

  const { rows: oldColumns } = await sql<{ column_name: string }>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'visits' AND column_name IN ('occurred_at', 'bot_classification', 'query')`.execute(
    db,
  )
  expect(oldColumns).toEqual([])

  // A visit inserted after the rename must still reach both rollup tables.
  await sql`INSERT INTO visits (id, domain_id, slug_requested, visited_at, is_bot, bot_classification_reason, platform, query_params) VALUES
    ('00000000-0000-7000-8000-0000000000a2', ${domain}, 'a', '2026-03-02T10:00:00Z', false, 'unknown', 'ios',
     '{"utm_source": ["mail"]}'::jsonb)`.execute(db)

  const { rows: days } = await sql<{ day: string; count: number }>`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, count::int AS count FROM visit_days
    WHERE dimension = 'total' ORDER BY day`.execute(db)
  expect(days).toEqual([
    { day: "2026-03-01", count: 1 },
    { day: "2026-03-02", count: 1 },
  ])

  const { rows: counts } = await sql<{ human: number; bot: number; last_visit_at: Date }>`
    SELECT human::int AS human, bot::int AS bot, last_visit_at FROM visit_counts`.execute(db)
  expect(counts).toEqual([{ human: 1, bot: 1, last_visit_at: new Date("2026-03-02T10:00:00Z") }])
})
