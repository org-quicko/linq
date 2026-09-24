---
name: linq-db-migration
description: Change linq's PostgreSQL schema or query types. Use when adding, reviewing, or applying a database migration.
---

# Changing the database schema

1. Add one reviewed, forward-only SQL file to `apps/server/drizzle/`, ordered
   after the existing migrations. Kysely's migration runner executes it, so
   PostgreSQL-specific DDL, triggers, and data changes stay explicit.
2. Apply it to an empty verification database with `bun run db:migrate`.
   Startup runs the same runner before bootstrap; the command is the explicit
   operator path.
3. With `DATABASE_URL` pointed at that migrated PostgreSQL database, run
   `bun run db:codegen` and commit `apps/server/src/db/types.generated.ts`.
   It describes query rows only; it never creates DDL.
4. Run `bun run typecheck` and the focused server test, then `bun run test`.
   The PGlite harness applies the same SQL migration sequence to a new database
   for every suite.

## Existing installations

The runner adopts a complete `__drizzle_migrations` journal into its namespaced
Kysely history table without replaying already-applied DDL. A partial or
unexpected legacy journal stops startup. Resolve that database deliberately;
do not reset or repair it from application code.
