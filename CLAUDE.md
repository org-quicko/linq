# CLAUDE.md

Read `AGENTS.md` first — it's the source of truth for how to run, test, and
modify this repo, and it applies to every agent working here, Claude
included. This file only adds what's Claude Code–specific.

## Skills

`.claude/skills/` packages the procedures `AGENTS.md` only summarizes. Load
one instead of improvising the same steps from scratch:

- `linq-dev` — starting the local dev environment (API server + Client UI,
  Postgres prerequisite, first-boot admin key, CORS gotcha).
- `linq-db-migration` — editing `apps/server/src/db/schema.ts` and generating
  the matching Drizzle migration.
- `linq-adr` — writing a new ADR in `docs/adr/` for a hard-to-reverse
  decision.
- `linq-plan` — writing a new design plan in `plans/` before implementing
  non-trivial work.
