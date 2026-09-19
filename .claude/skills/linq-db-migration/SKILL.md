---
name: linq-db-migration
description: Change linq's database schema and generate the matching migration. Use whenever apps/server/src/db/schema.ts is edited, or a Drizzle migration needs to be created or reviewed.
---

# Changing the database schema

1. Edit `apps/server/src/db/schema.ts` — this is the one source of truth for
   the schema. Never author or edit migration SQL by hand.
2. Generate the migration:

   ```bash
   bun run db:generate
   ```

   This needs `.env` / `DATABASE_URL` set (it shells out to `drizzle-kit`).
   It writes a new file under `apps/server/drizzle/` plus a `meta/` snapshot.
3. Read the generated SQL before committing it. If it's wrong, fix
   `schema.ts` and regenerate rather than patching the SQL directly — a
   hand-edited migration will drift from what `drizzle-kit`'s snapshot
   thinks the schema is, and later `db:generate` runs will produce diffs
   against the wrong baseline.
4. Don't run a separate "migrate" step yourself. Migrations apply
   automatically at boot of `bun run dev` / `bun run start` — that's the only
   place they run.

## Testing schema changes

`bun run test` never touches `DATABASE_URL`. Each suite spins up its own
in-memory Postgres via PGlite (`apps/server/test/helpers/db.ts`) and runs the
same generated migrations from `apps/server/drizzle/` against it — so a
missing or stale migration (schema.ts edited, `db:generate` not run) shows up
as a test failure, not just at deploy time. That's another reason never to
hand-edit the generated SQL: it's the thing the tests actually apply.
