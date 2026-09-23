---
name: linq-backend
description: Add or change an HTTP API resource in apps/server. Use when adding a route/endpoint, editing a permission check, or touching apps/server/src/http/api/, auth/permissions.ts, or a packages/shared schema.
---

# Adding or changing an API resource

Each resource is one file under `apps/server/src/http/api/` (see
`domains.ts` as the reference), mounted under `/api/v1` in `http/app.ts` —
order matters there, the redirect catch-all must stay last.

1. **Request/response shapes live in `packages/shared/src/<resource>.ts`**,
   re-exported from `index.ts` — zod schema plus the TypeScript type, never
   hand-rolled in `apps/server` or `apps/client`. Both apps import the same
   file, so it can't drift between them.
2. **Validate with `validate()`** from `http/validate.ts`
   (`validate("json" | "query" | "param", schema)`), read the result with
   `c.req.valid(...)`. It throws `ApiError.validation` through linq's error
   envelope — don't reach for Hono's own validator or throw manually.
3. **Check permissions first thing inside the handler**, not as middleware:
   `assertRole` / `assertCanEdit` / `assertCanArchive` / `assertCanPurge`
   from `auth/permissions.ts`. These wrap the `can.*` rules in
   `packages/shared/src/permissions.ts` — the same rules the Client UI reads
   to gate its own UI (see `linq-frontend`). Add a new capability there once;
   never duplicate the check with a hand-rolled role comparison.
4. **Errors are `ApiError.<kind>`** from `@linq/shared` (`notFound`,
   `conflict`, `forbidden`, `validation`) — `app.ts`'s `onError` turns these
   into the JSON envelope. A raw `throw new Error(...)` becomes an
   unhandled 500.
5. **DB access is `c.var.db`** (the `Db` type from `db/client.ts`), Drizzle
   query builder. Schema changes go through the `linq-db-migration` skill —
   never hand-edit `db/schema.ts` without regenerating the migration.
6. **Invalidate the cache after any write a cached read depends on**:
   `c.var.cache.del(...)` (see the `domainKey` calls in `domains.ts`) —
   otherwise a redirect or lookup serves the pre-write value until it
   expires.
7. **Sync Caddy when host-serving changes**: `c.var.caddy.upsert` /
   `.remove()`. Only wired when `LINQ_CADDY_ADMIN_URL` is set
   (`docs/adr/0012`) — calling it unconditionally is fine, it's a no-op
   otherwise.

## Testing

One file per resource under `apps/server/test/<resource>.test.ts`, using
`createHarness()` from `test/helpers/app.ts`: it spins up its own PGlite
instance, and gives you `request`/`post`/`patch` and `actor(role)` for
minting a principal of a given role. `bun run test` never touches
`DATABASE_URL` — don't gate a test on the real database being up.

Run `bun run test apps/server/test/<resource>.test.ts` while iterating,
`bun run test` before calling the change done.
