---
name: linq-backend
description: Add or change an HTTP API resource in apps/server. Use when adding a route or endpoint, editing a permission check, or touching apps/server/src/routes/, controllers/, services/, clients/, middleware/authorize.ts, or a packages/shared schema.
---

# Adding or changing an API resource

The server is layered `routes → controllers → services`, with clients of
external systems (database, cache, Caddy, link metadata) in `clients/`, the
logger and `HttpError` in `libs/`, and Hono middleware in `middleware/`. Each
folder has an `index.ts` barrel; import from it rather than reaching into
single files. `controllers/LinkController.ts` and `DomainController.ts` are the
references.

- **Route** (`routes/<Resource>Route.ts`): a function, not a class, e.g.
  `domainRoutes(domainService)`. Builds its controller once and returns the Hono
  sub-app(s) mapping each path to a controller method. Nothing else.
- **Controller** (`controllers/<Resource>Controller.ts`): a class taking its
  services in the constructor, one arrow-function property per endpoint taking
  a plain Hono `Context`. Each endpoint: `parseRequest` → load the resource if
  an unknown id should 404 first → `authorize` → service call → `c.json(...)`.
  JSDoc each endpoint with the method and path, `@param c`, `@returns`, `@throws`,
  and decorate it with `@Log("<resource>Controller.<endpoint>")`.
- **Service** (`services/<Resource>Service.ts`): a class taking its
  dependencies in the constructor (`db`, clients, `Pick<Config, …>`, another
  service when it needs one). All Kysely queries, business rules and side
  effects (cache invalidation, Caddy sync) live here. Never touches Hono's
  `Context`, so the CLI and bootstrap can use it too.

## One instance per app

`createApp` (`app.ts`) builds every service and controller exactly once and
injects them through constructors; a service that needs another gets the same
instance. No `getInstance()`, no module-level state, no `new XService(...)`
inside a request. The one exception: `new RuleService(tx)`, bound to a
transaction so its writes join it. Code that runs outside the app (bootstrap,
`cli/*`, tests) builds its own instance.

Only `principal` rides on the request context (`c.var.principal`, typed in
`middleware/authenticate.ts`). Everything else arrives through a constructor.

## Classes, helpers and utils

- **Utils are static classes.** Each `utils/<Name>Util.ts` (server and
  `packages/shared`) is one class named like its file, holding only `static`
  methods, plus `private static readonly` for its own constants. Call them as
  `SlugUtil.generateSlug(...)`, never as bare functions.
- **Converters are classes.** `converters/<resource>/`, one class per file,
  named exactly like the file. Use instance method `convertFrom` for source-to-target
  conversion and `convertTo` for the reverse; include only the directions needed.
  The class that uses a converter owns it: a `private readonly xyzConverter: XyzConverter`
  field assigned `new XyzConverter()` in its constructor, never a module-level
  instance. Call it through an arrow (`rows.map((row) => this.xyzConverter.convertFrom(row))`),
  not as an unbound method reference.
- **Logging belongs to `Logger`** in `libs/logger.ts`: `Logger.init`,
  `Logger.flush`, and `Logger.forRequest()` own lifecycle and request context.
  Use `@Log(operation, { in, out, level })` on asynchronous service methods and
  controller endpoint properties; projections
  return explicit safe fields and run only at debug level. `Logger.operation`
  covers standalone boot/migration functions. Expected errors use `HttpError`;
  unexpected error objects are logged once by `app.onError`.
- **Helpers are private methods at the end of their class.** A helper only one
  class uses is a `private` method (`private static` when it reads no instance
  state), after all public methods, not a module-level function. Example:
  `LinkService`'s `linkQuery` and `setLinkTags`.
- **Services → adapters → clients.** The `Cache` port and one adapter per
  backend live in `adapters/cache/`; `RedisCacheAdapter` talks to Redis through
  `clients/RedisClient`. Services depend on the adapter, never the client.
  `Caddy` and `MetadataFetcher` have a real client and a `Noop…` one in
  `clients/`. `CacheAdapter.start` / `XClient.start(config)` picks one, and
  `createApp` wraps it in its `Guarded…` decorator, so a down dependency never
  fails a request.
- **Request reading.** `parseRequest(c, target, schema)` in
  `middleware/requestParser.ts` validates a body, query or params with zod in
  linq's error envelope, reading them through `RequestUtil.read` exactly as
  Hono's validator would. Use `idParamSchema` for `/:id`.

## Steps

1. Request and response shapes live in `packages/shared/src/`: the zod schema
   in `schemas/<Resource>Schema.ts`, its type in `types/<Resource>Type.ts`,
   any fixed vocabulary in `constants/<Area>Constant.ts`, all re-exported from
   `"@linq/shared"`. Both apps use the same definition.
2. Add the queries and rules to the resource's service class; export a new
   file from `services/index.ts`.
3. Add the endpoint to the controller: validate with `parseRequest`, then
   check permissions with `authorize(c.var.principal, action, subject)` from
   `middleware/authorize.ts`. Load the resource first when an unknown id should
   404 before the permission question. Add a capability once to
   `packages/shared/src/utils/PermissionUtil.ts` when needed.
4. Throw `HttpError.<kind>` (`notFound`, `conflict`, `forbidden`,
   `validation`) from `libs/errors.ts` for expected failures, from either
   layer. It extends Hono's `HTTPException`; `app.ts` answers any
   `HTTPException` in the API envelope.
5. In the service, clear the cache after a write that affects cached redirect
   data (key builders in `utils/CacheKeyUtil.ts`), and sync Caddy with
   `caddy.upsert` or `.remove()` when a host-serving change needs it (a no-op
   unless Caddy is configured).
6. Map the path in the route function, build the service in `createApp`, and
   mount the route under `/api/v1`; export it from `routes/index.ts` and the
   controller from `controllers/index.ts`.
7. Database changes use the `linq-db-migration` workflow.

## Naming

Route, controller and service files are PascalCase (`LinkRoute.ts`,
`LinkController.ts`, `LinkService.ts`); `clients/` files are `<Name>Client.ts`
(cache adapters `<Backend>CacheAdapter.ts`), `utils/` files `<Name>Util.ts`;
`libs/` and `middleware/` files are camelCase. Functions and variables are
camelCase. DB columns and API JSON fields stay snake_case, because they are
the wire contract.

## Testing

Put resource tests in `apps/server/test/<resource>.test.ts`, using
`createHarness()` from `test/helpers/app.ts`. It creates an isolated PGlite
database and supplies request helpers, `actor(preset)`, and `flushVisits()` to
drain the app's visit inserts before asserting on `visits`. Run the focused
test while iterating, then `bun run test` before completion.
