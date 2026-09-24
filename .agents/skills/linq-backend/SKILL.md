---
name: linq-backend
description: Add or change an HTTP API resource in apps/server. Use when adding a route or endpoint, editing a permission check, or touching apps/server/src/http/api/, auth/permissions.ts, or a packages/shared schema.
---

# Adding or changing an API resource

Each resource is one file under `apps/server/src/http/api/` (see
`domains.ts` as the reference), mounted under `/api/v1` in `http/app.ts`.

1. Request and response shapes live in `packages/shared/src/<resource>.ts`,
   re-exported from `index.ts`: zod schema plus TypeScript type. Both apps use
   the same definition.
2. Validate with `validate()` from `http/validate.ts`, then read the result
   with `c.req.valid(...)`.
3. Check permissions first in the handler with the `assert*` helpers from
   `auth/permissions.ts`. Add a capability once to
   `packages/shared/src/permissions.ts` when needed.
4. Throw `ApiError.<kind>` (`notFound`, `conflict`, `forbidden`,
   `validation`) for expected failures; `app.ts` maps them to the API envelope.
5. Use `c.var.db` (`Db` from `db/client.ts`) and Kysely's query builder.
   Database changes use the `linq-db-migration` workflow.
6. Invalidate `c.var.cache` after a write that affects cached redirect data.
7. Sync Caddy with `c.var.caddy.upsert` or `.remove()` when a host-serving
   change needs it. It is a no-op unless Caddy is configured.

## Testing

Put resource tests in `apps/server/test/<resource>.test.ts`, using
`createHarness()` from `test/helpers/app.ts`. It creates an isolated PGlite
database and supplies request helpers and `actor(preset)`. Run the focused
test while iterating, then `bun run test` before completion.
