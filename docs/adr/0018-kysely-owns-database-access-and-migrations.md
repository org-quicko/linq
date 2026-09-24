# 0018 – Kysely owns database access and migrations

**Status**: accepted · 2026-09-24.

## Context

linq has one PostgreSQL database. Migrations run at startup before bootstrap,
and the server test suite creates an isolated PGlite database from the same
migration path. The database has PostgreSQL-specific invariants that cannot be
reduced to ordinary tables: enums, generated columns, partial and GiN indexes,
`NULLS NOT DISTINCT` constraints, functions, and visit-rollup triggers.

Drizzle currently owns table declarations, generated migration snapshots, the
runtime migration runner, and all server queries. Its current migration journal
records a schema history that existing installations have already applied.
Switching database tooling without an adoption path would either replay DDL
against populated tables or lose the ability to establish a fresh database.

Kysely provides the required typed query builder, executable migrations, and
PostgreSQL/PGlite dialects. It deliberately does not make a `Database` type a
DDL source or generate schema diffs. The project therefore needs a clear split
between authoritative migration DDL and generated query types.

## Decision

**Kysely is linq's only runtime database abstraction.** Production creates
`Kysely<Database>` with `PostgresDialect` and a managed `pg` pool. Tests create
the same `Db` type through `PGliteDialect`. The production pool is explicitly
destroyed during shutdown. Drizzle's query API, runtime migrator, and generated
table objects are removed rather than kept as a transition layer.

**Kysely migrations own schema DDL; generated types own query typing.** Frozen,
timestamp-ordered TypeScript migration modules under
`apps/server/src/db/migrations/` are the source of truth for tables and other
database objects. Each accepts `Kysely<unknown>` and does not import current
application schema code. They use the schema builder where exact and reviewed
parameterized SQL where PostgreSQL requires it. `kysely-codegen` introspects an
already-migrated PostgreSQL database to produce the committed
`types.generated.ts` file consumed by queries. Generated types never modify a
database and are regenerated after every schema migration.

**Kysely history begins with an explicit baseline adoption.** One initial
Kysely migration creates the complete current schema for fresh databases. At
startup, under a namespaced PostgreSQL advisory lock, a fully known
Drizzle-managed installation is verified, Kysely's explicitly named migration
and lock tables are initialized, and that initial migration is recorded as
applied without executing its DDL. A partial, unknown, or drifted legacy
history stops startup with an actionable error. The server never guesses,
repairs, resets, or replays historical DDL against an existing database.

**Migration execution remains boot-time and forward-only.** The Kysely
migrator runs to latest before bootstrap and is also available as an explicit
operator command. Releases do not call down migrations automatically. Any
schema change that needs data conversion, non-transactional DDL, or a recovery
procedure states it in the migration and, when consequential, in a separate
ADR.

## Consequences

- `pg`, Kysely, and Kysely's type generator become dependencies. The project
  must test driver conversions for bigint, JSONB, arrays, dates, and timestamps
  in both production PostgreSQL and PGlite; types alone cannot prove them.
- Schema changes are intentionally authored, not inferred from a live database.
  This gives PostgreSQL-specific DDL and data changes a reviewable versioned
  home, but it requires developers to write migrations and regenerate types as
  one change.
- The Kysely `Database` interface is derived output, not a competing schema
  declaration. CI must fail when migrations produce a schema that would change
  the committed generated types.
- Existing data is retained only when the prior migration journal and final
  schema pass the adoption checks. Operators with altered or partial state must
  resolve it deliberately, because automatic reconciliation risks data loss.
- Drizzle metadata and SQL remain read-only historical evidence during the
  adoption release, but no running process reads them after successful
  adoption. Removing that archive is separate housekeeping, not part of this
  migration.
