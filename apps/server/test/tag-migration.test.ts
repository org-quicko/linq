import { expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { Kysely, PGliteDialect, sql } from "kysely"
import { FileMigrationProvider, Migrator } from "kysely/migration"
import { migrationsFolder } from "../src/db/migrate.ts"

// 0003 moves live data, so it gets run against rows written under the old schema.
test("0003 backfills link_tags from links.tags, dropping duplicates", async () => {
  const db = new Kysely<unknown>({ dialect: new PGliteDialect({ pglite: new PGlite() }) })
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder: migrationsFolder }),
  })
  expect((await migrator.migrateTo("0002_bot_classification")).error).toBeUndefined()

  const domain = "00000000-0000-7000-8000-000000000001"
  await sql`INSERT INTO domains (id, host) VALUES (${domain}, 'm.test')`.execute(db)
  await sql`INSERT INTO links (id, domain_id, slug, destination, tags) VALUES
    ('00000000-0000-7000-8000-00000000000a', ${domain}, 'a', 'https://a.test/', ARRAY['z', 'y', 'z']),
    ('00000000-0000-7000-8000-00000000000b', ${domain}, 'b', 'https://b.test/', ARRAY['y']),
    ('00000000-0000-7000-8000-00000000000c', ${domain}, 'c', 'https://c.test/', '{}')`.execute(db)

  expect((await migrator.migrateToLatest()).error).toBeUndefined()

  const { rows } = await sql<{ slug: string; tags: string[] }>`
    SELECT l.slug, coalesce(array_agg(t.name ORDER BY t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS tags
    FROM links l LEFT JOIN link_tags lt ON lt.link_id = l.id LEFT JOIN tags t ON t.id = lt.tag_id
    GROUP BY l.slug ORDER BY l.slug`.execute(db)
  expect(rows).toEqual([
    { slug: "a", tags: ["y", "z"] },
    { slug: "b", tags: ["y"] },
    { slug: "c", tags: [] },
  ])
  expect((await sql`SELECT name FROM tags ORDER BY name`.execute(db)).rows).toEqual([
    { name: "y" },
    { name: "z" },
  ])

  // Purging a link takes its tag rows with it.
  await sql`DELETE FROM links WHERE slug = 'a'`.execute(db)
  expect((await sql`SELECT count(*)::int AS n FROM link_tags`.execute(db)).rows).toEqual([{ n: 1 }])
})
