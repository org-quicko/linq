import { expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { Kysely, PGliteDialect, sql } from "kysely"
import { FileMigrationProvider, Migrator } from "kysely/migration"
import { migrationsFolder } from "../src/db/migrate.ts"

const DIMENSIONS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const
const random = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(36).padStart(2, "0")).join("")

// 0005 rewrites visits and rebuilds the rollup, so it runs against rows written under 0004.
test("0005 adds content and term, caps every utm value, and rebuilds the rollup", async () => {
  const db = new Kysely<unknown>({ dialect: new PGliteDialect({ pglite: new PGlite() }) })
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder: migrationsFolder }),
  })
  expect((await migrator.migrateTo("0004_utm_dimensions")).error).toBeUndefined()

  const domain = "00000000-0000-7000-8000-000000000001"
  const long = "x".repeat(300) // compressible, so 0004 accepted it
  await sql`INSERT INTO domains (id, host) VALUES (${domain}, 'm.test')`.execute(db)
  await sql`INSERT INTO visits (id, domain_id, slug_requested, occurred_at, is_bot, platform, query) VALUES
    ('00000000-0000-7000-8000-0000000000a1', ${domain}, 'a', '2026-03-01T10:00:00Z', false, 'desktop',
      '{"utm_source":["Mail"],"utm_content":["Hero"],"utm_term":["Short"]}'),
    ('00000000-0000-7000-8000-0000000000a2', ${domain}, 'a', '2026-03-01T11:00:00Z', false, 'desktop',
      ${JSON.stringify({ utm_source: [long], utm_term: ["short"] })}::jsonb),
    ('00000000-0000-7000-8000-0000000000a3', ${domain}, 'a', '2026-03-02T10:00:00Z', true, 'desktop', NULL)`.execute(db)

  expect((await migrator.migrateToLatest()).error).toBeUndefined()

  // Backfilled from `query`, lowercased, and capped.
  const { rows } = await sql<{ id: string; utm_source: string | null; utm_content: string | null; utm_term: string | null }>`
    SELECT right(id::text, 2) AS id, utm_source, utm_content, utm_term FROM visits ORDER BY id`.execute(db)
  expect(rows.map((r) => [r.id, r.utm_content, r.utm_term])).toEqual([
    ["a1", "hero", "short"],
    ["a2", null, "short"],
    ["a3", null, null],
  ])
  expect(rows[0].utm_source).toBe("mail")
  expect(rows[1].utm_source).toBe("x".repeat(200))

  // The rollup equals a live aggregate for all five dimensions, truncated values included.
  const compare = async () => {
    for (const dim of DIMENSIONS) {
      const live = await sql<{ day: string; value: string; is_bot: boolean; count: number }>`
        SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, coalesce(${sql.ref(dim)}, '') AS value, is_bot, count(*)::int AS count
        FROM visits GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`.execute(db)
      const rolled = await sql<{ day: string; value: string; is_bot: boolean; count: number }>`
        SELECT to_char(day, 'YYYY-MM-DD') AS day, value, is_bot, count::int AS count
        FROM visit_days WHERE dimension::text = ${dim} ORDER BY 1, 2, 3`.execute(db)
      expect(rolled.rows).toEqual(live.rows)
    }
  }
  await compare()

  // The trigger counts the new dimensions, and a huge incompressible value no longer loses the visit.
  const huge = random(3000)
  await sql`INSERT INTO visits (id, domain_id, slug_requested, occurred_at, is_bot, platform, query) VALUES
    ('00000000-0000-7000-8000-0000000000a4', ${domain}, 'a', '2026-03-02T12:00:00Z', false, 'desktop',
      ${JSON.stringify({ utm_term: [huge], utm_campaign: [huge], utm_content: ["Hero"] })}::jsonb)`.execute(db)
  const stored = await sql<{ n: number }>`SELECT length(utm_term)::int AS n FROM visits WHERE right(id::text, 2) = 'a4'`.execute(db)
  expect(stored.rows).toEqual([{ n: 200 }])
  await compare()
})
