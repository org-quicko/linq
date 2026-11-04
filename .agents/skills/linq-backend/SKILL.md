---
name: linq-backend
description: Add or change an HTTP API resource in apps/server. Use when adding a route or endpoint, editing a permission check, or touching apps/server/src/<resource>/service.ts or routes.ts, auth/permissions.ts, or a packages/shared schema.
---

# Adding or changing an API resource

Each resource is one folder under `apps/server/src/` (see `domains/` as the
reference) holding two files:

- `service.ts`: the behaviour, as plain exported functions shaped
  `fn(deps: Deps, principal: Principal, input)`. Reads with no permission
  check take no principal.
- `routes.ts`: a Hono sub-app, mounted under `/api/v1` in `app/app.ts`, that
  validates the request and calls the service with `c.var`. Nothing else.

Steps:

1. Request and response shapes live in `packages/shared/src/<resource>.ts`,
   re-exported from `index.ts`: zod schema plus TypeScript type. Both apps use
   the same definition. A service takes the parsed input as
   `z.infer<typeof schema>`.
2. In `routes.ts`, validate with `validate()` from `app/validate.ts` and pass
   `c.req.valid(...)` to the service. No queries, permission checks or cache
   calls here.
3. In `service.ts`, check permissions first with the `assert*` helpers from
   `auth/permissions.ts`. Add a capability once to
   `packages/shared/src/permissions.ts` when needed.
4. Throw `ApiError.<kind>` (`notFound`, `conflict`, `forbidden`,
   `validation`) for expected failures; `app/app.ts` maps them to the API
   envelope. A service never touches Hono's `Context`.
5. Use `deps.db` (`Db` from `infra/db/client.ts`) and Kysely's query builder.
   Database changes use the `linq-db-migration` workflow.
6. After a write that changes what a redirect resolves to, write the cache
   entry through: `writeThrough(deps.cache, targetKey(...) or domainKey(...),
   () => loadTarget(...) or loadDomain(...))`, using the loaders in
   `redirect/resolve.ts`. Delete instead (`deps.cache.del`) only when the row
   is gone (purge) and for `llmsKey`. See `resources/docs/adr/0024`.
7. Sync Caddy with `deps.caddy.upsert` or `.remove()` when a host-serving
   change needs it. It is a no-op unless Caddy is configured.

Keeping all of that in the service is what lets a second entry point reuse it
without repeating the invalidation. See `resources/docs/adr/0023`.

## Testing

Put resource tests in `apps/server/test/<resource>.test.ts`, using
`createHarness()` from `test/helpers/app.ts`. It creates an isolated PGlite
database and supplies request helpers and `actor(preset)`. Run the focused
test while iterating, then `bun run test` before completion.
