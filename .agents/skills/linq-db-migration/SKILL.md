---
name: linq-db-migration
description: Change linq's PostgreSQL schema or query types. Use when adding, reviewing, or applying a database migration.
---

# Changing the database schema

1. Add one forward-only Kysely migration to `apps/server/src/db/migrations/`,
   named `NNNN_<description>.ts` so it sorts after the existing ones. Export
   `up(db: Kysely<unknown>)`; never import application types or helpers, and
   never change what a shipped migration executes, or its file name. The
   runner records applied migrations by name only, so an edited statement
   silently diverges fresh databases from existing ones, and a rename re-runs
   it. Comment-only edits (such as a moved doc path) are safe. `0001_initial.ts` is the baseline
   schema and the reference for style.
2. Use the schema builder where it expresses the DDL exactly, and `sql` for
   PostgreSQL-specific DDL (enums, generated columns, partial/GIN indexes,
   `NULLS NOT DISTINCT`, functions, triggers). Run one statement per `sql`
   call: PGlite rejects multi-statement queries. Leave object names
   unqualified so they land in `LINQ_DB_SCHEMA`. Give a new table, and any
   column whose meaning is not obvious from its name, a `COMMENT ON` in the
   same migration, and update the comment when a change alters what a column
   means. `0008_schema_comments.ts` holds the existing ones.
3. Apply it to an empty verification database with `bun run db:migrate`.
   Startup runs the same runner before bootstrap.
4. With `DATABASE_URL` pointed at that migrated database, run
   `bun run db:codegen` and commit `apps/server/src/db/types.generated.ts`.
   It describes query rows only; it never creates DDL. Keep its hand-tuned
   JSON column shapes and bigint-as-number types.
5. Against the same database, migrated in the `public` schema, refresh the
   schema dump and commit it:
   `pg_dump --schema-only --no-owner --no-privileges --restrict-key=linq --exclude-table='linq_kysely_migration*' "$DATABASE_URL" > resources/sql/schema.sql`.
   The fixed restrict key keeps the file identical between runs.
6. Run `bun run typecheck` and the focused server test, then `bun run test`.
   The PGlite harness applies the same migrations to a new database for every
   suite.

A migration that needs a data backfill, non-transactional DDL (for example
`CREATE INDEX CONCURRENTLY`) or a manual recovery step says so in a comment,
and in an ADR when it is consequential. There are no down migrations.
