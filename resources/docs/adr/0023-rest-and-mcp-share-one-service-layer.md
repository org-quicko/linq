# 0023 – REST and MCP share one service layer

**Status**: accepted · 2026-11-04.

## Context

Every API resource was one file under `http/api/` in which each Hono handler
did three jobs at once: parse the request, check the principal's
permissions, and run the Kysely queries, transactions, cache invalidations
and Caddy calls. `links.ts` was 508 lines of this.

That held while HTTP was the only way in. linq is about to gain an MCP server
whose tools create, edit and archive links exactly as the REST endpoints do.
Logic that lives inside a Hono handler cannot be called from a tool, so each
tool would have to repeat it, and the part most easily forgotten is the part
`linkKeys` exists to protect: clearing the redirect's cache entry and the
domain's `/llms.txt` after a write. A tool that forgot it would leave a short
link redirecting to its old destination for up to `LINQ_CACHE_TTL`.

## Decision

Each resource is a folder (`links/`, `domains/`, `rules/`, `qr-codes/`,
`keys/`, `visits/`, `analytics/`) with two files:

- `service.ts` holds the behaviour as plain functions shaped
  `fn(deps, principal, input)`. They check permissions, run queries and
  transactions, invalidate the cache and sync Caddy. They throw `ApiError`
  for expected failures and never see Hono's `Context`. Reads that need no
  permission check take no principal.
- `routes.ts` validates the request with the `@linq/shared` schemas and calls
  the service. It holds nothing else.

`Deps` (`deps.ts`) is `{ db, config, cache, caddy, metadata }`. The Hono
`Env` is `Deps` plus the principal, so a route passes `c.var` straight
through, and any other entry point builds the same object.

Process-wide plumbing moves to `infra/`, and the public redirect and
`/llms.txt` to `redirect/`.

Organising by layer was considered and rejected: separate `routes/`,
`controllers/`, `services/` and `models/` folders would scatter one resource
across four places, and linq's schemas already live in `@linq/shared` and its
row types in the generated Kysely types. Classes were rejected for the same
reason the rest of the server has none: there is no per-instance state to
hold.

## Consequences

- Permission checks moved from the route to the service, so every entry
  point gets them, and a service cannot be called without a principal unless
  it is a read that never needed one.
- The ordering rules that were enforced inline still are. Examples: `loadLink`
  runs before the permission check so an unknown link is a 404, not a 403, and
  the domain archive's `FOR UPDATE` pairs with `createLink`'s `FOR SHARE`.
  They now live in one place per operation.
- A new resource is a new folder with both files. `.agents/skills/linq-backend`
  describes the procedure.
- This changes no behaviour and no HTTP contract. The test suite passed
  unchanged across the move, apart from import paths.
