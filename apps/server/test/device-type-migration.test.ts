import { expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { Kysely, PGliteDialect, sql } from "kysely"
import { FileMigrationProvider, Migrator } from "kysely/migration"
import { migrationsFolder } from "../src/db/migrate.ts"

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1"
const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1"
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36"

// 0006 adds a generated column and rebuilds one rollup dimension, so it runs against rows written under 0005.
test("0006 backfills device_type from the user agent and rolls it up", async () => {
  const db = new Kysely<unknown>({ dialect: new PGliteDialect({ pglite: new PGlite() }) })
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder: migrationsFolder }),
  })
  expect((await migrator.migrateTo("0005_utm_content_term")).error).toBeUndefined()

  const domain = "00000000-0000-7000-8000-000000000001"
  await sql`INSERT INTO domains (id, host) VALUES (${domain}, 'm.test')`.execute(db)
  await sql`INSERT INTO visits (id, domain_id, slug_requested, occurred_at, is_bot, platform, user_agent) VALUES
    ('00000000-0000-7000-8000-0000000000a1', ${domain}, 'a', '2026-03-01T10:00:00Z', false, 'ios', ${IPHONE}),
    ('00000000-0000-7000-8000-0000000000a2', ${domain}, 'a', '2026-03-01T11:00:00Z', false, 'ios', ${IPAD}),
    ('00000000-0000-7000-8000-0000000000a3', ${domain}, 'a', '2026-03-02T10:00:00Z', true, 'desktop', ${WINDOWS}),
    ('00000000-0000-7000-8000-0000000000a4', ${domain}, 'a', '2026-03-02T11:00:00Z', true, 'desktop', NULL)`.execute(
    db,
  )

  expect((await migrator.migrateToLatest()).error).toBeUndefined()

  const { rows } = await sql<{ id: string; device_type: string | null }>`
    SELECT right(id::text, 2) AS id, device_type FROM visits ORDER BY id`.execute(db)
  expect(rows.map((r) => [r.id, r.device_type])).toEqual([
    ["a1", "mobile"],
    ["a2", "tablet"],
    ["a3", "desktop"],
    ["a4", null],
  ])

  // The rollup equals a live aggregate, before and after the trigger counts a new visit.
  const compare = async () => {
    const live = await sql<{ day: string; value: string; is_bot: boolean; count: number }>`
      SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, coalesce(device_type, '') AS value, is_bot, count(*)::int AS count
      FROM visits GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`.execute(db)
    const rolled = await sql<{ day: string; value: string; is_bot: boolean; count: number }>`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, value, is_bot, count::int AS count
      FROM visit_days WHERE dimension = 'device_type' ORDER BY 1, 2, 3`.execute(db)
    expect(rolled.rows).toEqual(live.rows)
  }
  await compare()
  await sql`INSERT INTO visits (id, domain_id, slug_requested, occurred_at, is_bot, platform, user_agent) VALUES
    ('00000000-0000-7000-8000-0000000000a5', ${domain}, 'a', '2026-03-02T12:00:00Z', false, 'ios', ${IPAD})`.execute(
    db,
  )
  await compare()
})
