---
name: linq-backend
description: Add or change an HTTP API resource in apps/server. Use when adding a route or endpoint, editing a permission check, or touching apps/server/src/routes/, apps/server/src/services/, middleware/authorize.ts, or a packages/shared schema.
---

# Adding or changing an API resource

The server is layered `routes → services`, with shared infrastructure in
`libs/` and Hono middleware in `middleware/`. Each folder has an `index.ts`
barrel; import from it rather than reaching into single files.

- **Route** (`apps/server/src/routes/<Resource>Route.ts`, e.g. `DomainRoute.ts`
  as the reference): thin. Validates input, checks permissions, calls the
  service, runs side effects (cache invalidation, Caddy sync, metadata fetch),
  and returns `c.json(...)`. No SQL here.
- **Service** (`apps/server/src/services/<Resource>Service.ts`): plain
  exported functions taking `db: Db` first. All Kysely queries and business
  rules live here. Never touches Hono's `Context`, so the CLI and bootstrap can
  call it too.

## Steps

1. Request and response shapes live in `packages/shared/src/<resource>.ts`,
   re-exported from `index.ts`: zod schema plus TypeScript type. Both apps use
   the same definition.
2. Add the queries to the resource's service, and export the new file from
   `services/index.ts`.
3. In the route, validate with `validate()` (or `idParam` for `/:id`) from
   `middleware/validate.ts`, then read the result with `c.req.valid(...)`.
4. Check permissions with `assertCan(principal, action, subject)` from
   `middleware/authorize.ts`. Load the resource first when an unknown id
   should 404 before the permission question. Add a capability once to
   `packages/shared/src/permissions.ts` when needed.
5. Throw `ApiError.<kind>` (`notFound`, `conflict`, `forbidden`,
   `validation`) for expected failures, from either layer; `app.ts` maps them
   to the API envelope.
6. Invalidate `c.var.cache` in the route after a write that affects cached
   redirect data (key builders in `libs/cache.ts`).
7. Sync Caddy with `c.var.caddy.upsert` or `.remove()` when a host-serving
   change needs it. It is a no-op unless Caddy is configured.
8. Mount a new route in `app.ts` under `/api/v1`, and export it from
   `routes/index.ts`.
9. Database changes use the `linq-db-migration` workflow.

## Naming

Route and service files are PascalCase (`LinkRoute.ts`, `LinkService.ts`);
`libs/` and `middleware/` files are camelCase. Functions and variables are
camelCase. DB columns and API JSON fields stay snake_case, because they are
the wire contract.

## Testing

Put resource tests in `apps/server/test/<resource>.test.ts`, using
`createHarness()` from `test/helpers/app.ts`. It creates an isolated PGlite
database and supplies request helpers and `actor(preset)`. Run the focused
test while iterating, then `bun run test` before completion.
