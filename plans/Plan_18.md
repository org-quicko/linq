# linq — Plan 18: Caddy stays in sync with domains

Follows `plans/Plan_17.md`.

## Context

`links.ts:36` already notes that production linq assumes "something" terminates
TLS in front of it — nothing does. Every domain a customer adds
(`apps/server/src/http/api/domains.ts`) only ever becomes a row in `domains`;
nothing outside the database ever learns a new host exists. There is no
reverse proxy, no certificate, no routing. The request is to run Caddy as a
sidecar container and have linq push its domain table into Caddy automatically
on every create/patch/archive/purge, so adding a domain in linq is enough to
make it resolve over HTTPS with no manual Caddy edit.

## Decisions

- **Caddy's admin API (JSON config over HTTP, `:2019`), not a Caddyfile.**
  Caddy ships a config skeleton at boot (`caddy/caddy.json`, checked into the
  repo, mounted read-only) with an empty `routes` array on one HTTP server.
  linq talks to `:2019` over the compose network — never published to the
  host — with plain `fetch`. No file writes into another container's volume,
  no `docker exec`, no reload signal. Automatic HTTPS is Caddy's native
  behaviour for any route whose host looks like a real domain, so nothing
  extra is written for certificates — Caddy issues and renews them itself.
- **Per-domain incremental sync, addressed by Caddy's `@id`, not a
  full-list replace.** Every domain gets a stable route id, `domain:<uuid>`.
  A create or reactivate does `DELETE /id/domain:<id>` (tolerating 404) then
  `POST` one new route object tagged with that `@id` — delete-then-add is
  what makes it idempotent without asking Caddy what it currently holds. An
  archive, delete, or purge does one `DELETE /id/domain:<id>`. **No mutation
  ever queries or rewrites every other domain's route** — a customer with a
  thousand domains costs the same one or two small HTTP calls per mutation as
  a customer with two, and two admins touching two different domains at once
  never contend over shared state, because each domain's route is an
  independent object. The only place the full active-domain list is read is
  once, at linq boot (`reconcileCaddy`, below), to repair Caddy's routes after
  *Caddy's own* restart wipes it back to its empty skeleton — a boot-time cost
  is fine to pay in full every time; a per-request one is not.
- **A sync failure never fails the domain request**, mirroring
  `guarded(cache)` in `cache.ts` exactly: caught, logged at `error`, the HTTP
  response still succeeds. The next successful mutation — or the next linq
  boot — repairs it. Unlike a misconfigured Redis (`docs/adr/0009`, connect-or-die),
  **an unreachable Caddy at boot is not fatal.** Caddy depends on linq to be
  reachable at `LINQ_CADDY_UPSTREAM`, not the other way around; making linq's
  own boot depend on its reverse proxy being up would invert that.
- **The feature is entirely opt-in.** `LINQ_CADDY_ADMIN_URL` unset ⇒ a
  no-op `Caddy` client, identical in shape to `noCache`. Every existing
  install, test, and the example compose file's non-Caddy path keeps working
  unchanged.

---

## 1. Config — `apps/server/src/config.ts`, `.env.example`

```ts
LINQ_CADDY_ADMIN_URL: z.string().min(1).optional(),
/** Where Caddy reverse-proxies a matched host to. Required once the admin URL is set. */
LINQ_CADDY_UPSTREAM: z.string().min(1).optional(),
```

Add to the existing `superRefine` (same shape as the redis check): naming
`LINQ_CADDY_ADMIN_URL` without `LINQ_CADDY_UPSTREAM` is rejected at boot.

`.env.example` — two new commented-out lines under a short block, same tone as
the existing Redis section, noting that setting `LINQ_CADDY_ADMIN_URL` is what
turns the feature on.

## 2. New module — `apps/server/src/caddy.ts`

Mirrors `cache.ts`'s shape (`Cache`/`noCache`/`guarded`/`startCache`), but with
two operations instead of one:

```ts
export type Caddy = {
  upsert(domainId: string, host: string): Promise<void>
  remove(domainId: string): Promise<void>
}

export const noCaddy: Caddy = { upsert: async () => {}, remove: async () => {} }

/** Never lets a sync failure fail the caller's request. See docs/adr/0012. */
export function guarded(caddy: Caddy): Caddy {
  return {
    async upsert(domainId, host) {
      try {
        await caddy.upsert(domainId, host)
      } catch (err) {
        reqLog().error({ err, domainId }, "caddy upsert failed")
      }
    },
    async remove(domainId) {
      try {
        await caddy.remove(domainId)
      } catch (err) {
        reqLog().error({ err, domainId }, "caddy remove failed")
      }
    },
  }
}

/** Caddy's host matcher works on hostname only; a stored host may carry a port. */
function hostnameOf(host: string): string {
  return host.split(":")[0]
}

/** One domain, one route object, addressed by this id for its whole lifetime. */
function routeId(domainId: string): string {
  return `domain:${domainId}`
}

export function startCaddy(config: Config): Caddy {
  if (!config.LINQ_CADDY_ADMIN_URL) return noCaddy
  const adminUrl = config.LINQ_CADDY_ADMIN_URL
  const upstream = config.LINQ_CADDY_UPSTREAM! // enforced by config's superRefine

  async function remove(domainId: string): Promise<void> {
    const res = await fetch(`${adminUrl}/id/${routeId(domainId)}`, { method: "DELETE" })
    // 404 is the idempotent case — already gone — not a failure.
    if (!res.ok && res.status !== 404) {
      throw new Error(`caddy admin API ${res.status}: ${await res.text()}`)
    }
  }

  return {
    async upsert(domainId, host) {
      await span(
        "caddy.upsert",
        async () => {
          // Delete-then-add is what makes this idempotent without first
          // asking Caddy what it currently holds: a reactivated domain and a
          // brand-new one look identical to this call.
          await remove(domainId)
          const res = await fetch(`${adminUrl}/config/apps/http/servers/srv0/routes`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              "@id": routeId(domainId),
              match: [{ host: [hostnameOf(host)] }],
              handle: [{ handler: "reverse_proxy", upstreams: [{ dial: upstream }] }],
            }),
          })
          if (!res.ok) throw new Error(`caddy admin API ${res.status}: ${await res.text()}`)
        },
        { in: { domainId } },
      )
    },
    remove: (domainId) => span("caddy.remove", () => remove(domainId), { in: { domainId } }),
  }
}

/**
 * Repairs Caddy's routes after Caddy's own restart wipes it back to its empty
 * skeleton. The only place a mutation reads every domain instead of one — a
 * boot-time cost, paid once, never per-request.
 */
export async function reconcileCaddy(db: Db, caddy: Caddy): Promise<void> {
  const rows = await db
    .select({ id: domains.id, host: domains.host })
    .from(domains)
    .where(eq(domains.status, "active"))
  for (const row of rows) await caddy.upsert(row.id, row.host)
}
```

`main.ts` wraps `startCaddy(config)` in `guarded(...)`, same as
`guarded(cache)` — the unwrapped version is what `caddy.test.ts` exercises
directly so a thrown error is observable in the test.

## 3. Wiring — env, app, main

- `apps/server/src/http/env.ts` — `Env.Variables` gains `caddy: Caddy`.
- `apps/server/src/http/app.ts` — `AppDeps` gains `caddy?: Caddy` (default
  `noCaddy`, same default-parameter style as `cache = noCache`); `createApp`
  wraps it with `guarded` and `c.set("caddy", safeCaddy)` right next to the
  existing `c.set("cache", safeCache)`.
- `apps/server/src/main.ts`:
  ```ts
  const caddy = guarded(startCaddy(config))
  const app = createApp({ db, config, cache, caddy })
  // Repairs Caddy's routes after its own restart, or a first boot alongside a
  // fresh Caddy container whose skeleton config has no routes yet.
  await reconcileCaddy(db, caddy)
  ```

## 4. Routes — `apps/server/src/http/api/domains.ts`

Each handler already has the `id` and `host` it needs in hand — no extra
query. Add one call next to each existing `c.var.cache.del(...)`:

- **`POST /`** — after the insert: `await c.var.caddy.upsert(row.id, row.host)`.
- **`PATCH /:id`** — only when the patch actually touches `status` (a
  fallback-URL-only patch changes nothing about routing):
  ```ts
  if (patch.status !== undefined) {
    if (patch.status === "archived") await c.var.caddy.remove(id)
    else await c.var.caddy.upsert(id, before.host)
  }
  ```
- **`DELETE /:id`** (archive alias) — `await c.var.caddy.remove(id)`.
- **`DELETE /:id/purge`** — `await c.var.caddy.remove(id)`, defensively;
  normally already removed by the archive that purging requires, but the call
  is idempotent (404-tolerant) so calling it again costs nothing.

## 5. Docker

**New `caddy/caddy.json`** (checked in), the skeleton Caddy loads at its own
boot, before linq has synced anything:

```json
{
  "admin": { "listen": "0.0.0.0:2019" },
  "apps": {
    "http": {
      "servers": {
        "srv0": { "listen": [":80", ":443"], "routes": [] }
      }
    }
  }
}
```

**`docker-compose.example.yml`** — new `caddy` service, and two new lines on
`linq`:

```yaml
  caddy:
    image: caddy:2
    command: caddy run --config /etc/caddy/caddy.json --adapter json
    volumes:
      - ./caddy/caddy.json:/etc/caddy/caddy.json:ro
      - caddy-data:/data      # issued certificates — must persist
      - caddy-config:/config
    ports:
      - "80:80"
      - "443:443"
      # :2019 (admin API) is deliberately NOT published — reachable only
      # from linq, over the compose network, as http://caddy:2019.
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:2019/config/"]
      interval: 5s
      timeout: 5s
      retries: 10

  linq:
    # ...
    depends_on:
      postgres:
        condition: service_healthy
      caddy:
        condition: service_healthy
    environment:
      # ...
      LINQ_CADDY_ADMIN_URL: http://caddy:2019
      LINQ_CADDY_UPSTREAM: linq:3000
```

and add `caddy-data`, `caddy-config` to the top-level `volumes:`.

No `Dockerfile` change — Caddy is its own official image, not built into
linq's.

## 6. Tests

- `apps/server/test/helpers/app.ts` — `HarnessOptions` gains `caddy?: Caddy`;
  `createHarness` passes `caddy: options.caddy ?? noCaddy` into `createApp`,
  same as `cache`. No existing test changes.
- **New `apps/server/test/caddy.test.ts`** — stubs `globalThis.fetch`:
  - `startCaddy` with no `LINQ_CADDY_ADMIN_URL` returns `noCaddy` (`upsert`/
    `remove` never call `fetch`).
  - `upsert(id, host)` issues a `DELETE /id/domain:<id>` then a `POST` whose
    body carries `"@id": "domain:<id>"` and the host.
  - A host stored with a port (`localhost:3000`) is matched by hostname only.
  - `remove` treats a `404` from the `DELETE` as success, not an error.
  - `guarded(caddy)` swallows a rejecting/non-`ok` fetch on either method and
    resolves rather than throwing.
  - `reconcileCaddy(db, caddy)` calls `upsert` once per **active** domain and
    not for archived ones.
- `apps/server/test/domains.test.ts` — add a plain object test double
  (`{ upserts: [], removes: [], upsert: async (id, host) => {...}, remove: async (id) => {...} }`,
  no mocking library, matching this file's existing convention) passed as
  `caddy` to `createHarness`. Assert: create → one `upsert`; archive
  (`PATCH status:"archived"` and plain `DELETE`) → one `remove`; reactivate
  (`PATCH status:"active"`) → one `upsert`; a `fallbackUrl`-only patch →
  neither called; purge → one `remove`.

## 7. Docs

- `.env.example` — the two new vars (§1).
- `README.md`, under `## Docker` — a short paragraph: what `LINQ_CADDY_ADMIN_URL`
  turns on, that `:2019` stays internal to the compose network, and that a
  custom domain still needs public DNS pointing at the host before Caddy's
  automatic HTTPS can issue it a certificate.
- **New `docs/adr/0012-caddy-is-the-tls-terminator.md`** — why Caddy
  (native JSON admin API, native automatic HTTPS, no separate cert-manager);
  why each domain is synced as its own `@id`-addressed route rather than the
  whole list being replaced on every mutation (cost and lock contention
  independent of domain count); why a sync failure is logged and swallowed
  rather than failing the request, and why that is *not* the same call the
  Redis connectivity check (`docs/adr/0009`) makes, and why
  unreachable-Caddy-at-boot does not stop linq from starting.
- `CONTEXT.md` is untouched — Caddy is an implementation detail behind the
  existing **Domain** term, not new vocabulary.

---

## Sequencing

1. §1 config.
2. §2 the `caddy.ts` module — nothing else compiles against it until this exists.
3. §3 wiring (env/app/main).
4. §4 the four call sites in `domains.ts`.
5. §6 tests, `bun test`.
6. §5 Docker files.
7. §7 docs and the ADR.

## Verification

1. `bun run typecheck`, `bun run lint`, `bun test`.
2. `docker compose -f docker-compose.example.yml up` with the new `caddy`
   service: confirm `docker compose logs caddy` shows it healthy before `linq`
   starts, and `docker compose logs linq` shows no fatal error even if Caddy
   were paused first (unreachable-at-boot is non-fatal).
3. Create a domain via `POST /api/v1/domains` with a real, publicly resolvable
   test host; confirm `docker compose exec caddy wget -qO- localhost:2019/id/domain:<id>`
   returns that one route, and that the host now serves over HTTPS through
   Caddy (a certificate is visibly requested in `docker compose logs caddy`).
4. Create a second domain with a different host; confirm the first domain's
   route is untouched (`GET /id/domain:<first-id>` still returns it) — proof
   that one domain's sync never touches another's.
5. Archive the first domain (`DELETE /api/v1/domains/:id`); confirm
   `GET /id/domain:<id>` now 404s and the host stops resolving through Caddy,
   while the second domain keeps serving.
6. Reactivate it (`PATCH { status: "active" }`); confirm its route comes back.
7. Purge it; confirm no route reappears.
8. Stop and restart the `caddy` container alone (its in-memory config resets
   to the empty skeleton); confirm restarting **linq** repairs every active
   domain's route via the boot-time `reconcileCaddy` call, without needing any
   domain mutation.

## Risks

- **Automatic HTTPS needs real, public DNS and reachable ports 80/443.** In a
  local or LAN-only compose setup, Caddy will keep retrying ACME validation
  and failing quietly in its own logs; this is an operational fact about TLS
  issuance, not something linq's sync can paper over.
- **A sync that fails mid-outage leaves that one domain's route stale until
  its next mutation or the next linq boot.** There is no cache-style TTL
  backstop — acceptable because it is scoped to the one domain that failed,
  not the whole set, but worth knowing it isn't self-healing on a timer.
- **`upsert`'s delete-then-add is two calls, not one transaction.** A request
  landing in the instant between the `DELETE` and the `POST` sees no route for
  that domain. The window is one HTTP round-trip to `:2019` inside the compose
  network, and it affects only the domain being created or reactivated, never
  any other domain.
