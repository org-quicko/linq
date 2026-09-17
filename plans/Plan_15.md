# linq — Plan 15: editor becomes manager, and the cache sweeps

Follows `plans/Plan_14.md`.

## Context

Two asks, and the second is smaller than it sounds once the current state is on
the table.

**`editor` becomes `manager`.** The role ladder is `viewer < author < editor <
admin`, and `editor` is the rung that manages any Link rather than only its own.
The name should say that. This is a rename all the way down: `role` is a real
Postgres `ENUM` type (`apps/server/drizzle/0000_init.sql:3`), so the value lives
in the database, in the API contract, in the permission ladder and on screen.

The rename is far less invasive than that sounds, because the codebase already
routes through one place. There is **no literal `"editor"` anywhere in
`apps/server/src`** — every editor-level gate goes through `can.editLink`
(`packages/shared/src/permissions.ts:28-30`) — and **none in `apps/client`
either**, because the role dropdown is built from the `ROLES` tuple
(`apps/client/app/settings/users/page.tsx:41`) and renders the enum string as
its own label. Rename the tuple and the UI follows.

What the rename does expose is a duplication worth removing while we are here.
`packages/shared/src/roles.ts` states the ladder twice — once as the ordered
`ROLES` tuple and once as a hand-written `RANK` map that repeats the same order
as numbers. `packages/shared/src/users.ts:29` states the role set a third time,
as a hand-written union duplicating the `Role` type. A rename that updates two
of three and misses the third compiles and fails at runtime, which is exactly
the bug this plan should not be able to introduce.

**The cache.** Both halves of the second ask are already partly done, so the
work is narrower than the words:

- *Eviction* is already on. `memoryCache` passes `max` from
  `LINQ_CACHE_MAX_ENTRIES` (`apps/server/src/cache.ts:145`), eviction is by
  recency, and `apps/server/test/cache.test.ts:239` proves a read rescues an
  entry from the next eviction. What is **not** enabled is *proactive expiry*:
  `ttlAutopurge` is off, so an entry that lapses and is never touched again
  holds its memory until something reads it or the cap walks past it. That is
  the real gap, and closing it is this plan's §5.
- *TTL in the env file* is already there — `.env.example:22` carries
  `LINQ_CACHE_TTL=300`, uncommented. The actual gap is the untracked local
  `.env`, which predates every cache setting, carries none of them, and still
  sets `LINQ_GEO_ENABLED` and `LINQ_TRUST_PROXY` — both deleted in Plan_14.
  That is §6.

## Decisions

- **The rename goes all the way down**, including the Postgres enum value. No
  translation layer mapping `manager` to a stored `editor`: one name, stated
  once. API clients must send `manager`; nothing has shipped, so there is no
  compatibility window to keep.
- **The enum is renamed in place**, with `ALTER TYPE … RENAME VALUE`, not
  dropped and recreated. It rewrites no rows, keeps the sort position (so the
  ladder order is unchanged), touches no index, and needs no `UPDATE` of
  `users.role`. API keys need nothing either: `api_keys` has no role column, and
  a principal's role is resolved at auth time by joining to `users`
  (`apps/server/src/auth/middleware.ts:26-36`).
- **`RANK` is deleted, not renamed.** `roleAtLeast` compares positions in the
  `ROLES` tuple directly. This is slightly more than the literal ask, and it
  earns its place: it removes the second statement of the ladder, which is the
  thing most likely to be renamed inconsistently. Same for the hand-written
  union in `users.ts:29`, which becomes `Role`.
- **Proactive expiry is a single periodic `purgeStale()`, not `ttlAutopurge`.**
  `ttlAutopurge: true` is one line, but it arms a timer per cached entry — up to
  `LINQ_CACHE_MAX_ENTRIES` of them, 10 000 by default. One interval for the
  whole store does the same job at a fixed cost.
- **The sweep interval is derived from the TTL, not a setting and not a
  constant.** `min(ttl, 60s)`. A fixed 60 s is wrong at both ends: at
  `LINQ_CACHE_TTL=1` it lets dead entries hold slots for 60 TTLs, which is the
  failure this is meant to fix, and at a one-hour TTL it scans for nothing. No
  floor is needed — `LINQ_CACHE_TTL` is already `min(1)` in config, so the
  interval cannot fall below 1 s. It stays out of the env: it changes only
  reclaim latency, never an answer.
- **`updateAgeOnGet` stays off.** ADR 0009 and Plan_13 both bind us here and the
  reasoning is unchanged: a sliding TTL costs a write per cache *hit*, and a
  permanently hot key would never re-read a row that changed behind the API's
  back. Not revisited.

---

## 1. The ladder, stated once — `packages/shared/src/roles.ts`

The source of truth for the rename. Today, lines 4-13:

```ts
export const ROLES = ["viewer", "author", "editor", "admin"] as const
const RANK: Record<Role, number> = { viewer: 0, author: 1, editor: 2, admin: 3 }
export function roleAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min]
}
```

Becomes one statement of the order:

```ts
/** Ordered least to most privileged. Comparisons rely on this order. */
export const ROLES = ["viewer", "author", "manager", "admin"] as const

/** True when `role` is at least as privileged as `min`. */
export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(min)
}
```

`Role`, `roleSchema` and every consumer follow from the tuple unchanged. The
`indexOf` scan is over four elements on a path that already does a database
round trip; the map it replaces bought nothing measurable and cost a second
place to be wrong.

`packages/shared/src/users.ts:29` — replace the hand-written
`"viewer" | "author" | "editor" | "admin"` union on the `User` type with `Role`,
imported from `./roles.ts`.

`packages/shared/src/permissions.ts` — line 29 is the **only** real permission
check naming the role, inside `can.editLink`:
`roleAtLeast(actor.role, "editor")` → `"manager"`. The doc comments at lines 25
and 33 say "Editors and admins…" and "An editor may change any link…" and want
the same word changed.

## 2. The database — migration `0007`

`apps/server/src/db/schema.ts:19`:

```ts
export const roleEnum = pgEnum("role", ["viewer", "author", "manager", "admin"])
```

Then `bun run db:generate --name rename_editor_to_manager` for the journal entry
and meta snapshot — and **replace the generated SQL**. Drizzle diffs snapshots
and cannot see a rename; it will emit a drop-and-recreate of the type, which
fails while `users.role` depends on it. The whole migration is one statement:

```sql
-- `manager` is what the rung has always done: manage any link, not only its own.
-- RENAME VALUE rewrites no rows and keeps the value's sort position, so the
-- ladder order in packages/shared/src/roles.ts is still the enum's own order.
ALTER TYPE "public"."role" RENAME VALUE 'editor' TO 'manager';
```

This is the same shape as Plan_14 §3: let drizzle produce the artifacts, then
hand-write the body. Confirm the generated `0007_*.sql` was fully replaced and
that `meta/0007_snapshot.json` carries `manager` in the `public.role` values.

No data migration. `users.role` is the only column of the type, and
`RENAME VALUE` updates every row's value by definition.

## 3. Server, client and the generated artifacts

**Server: nothing to change.** There is no literal `"editor"` in
`apps/server/src`. `assertRole` takes a `Role`, `assertCanEdit` delegates to
`can.editLink`, and `bootstrap.ts:29` only ever seeds `admin`. The rename
reaches the server entirely through the shared package — worth confirming with a
grep rather than assuming.

**Client: nothing to change either.**
`apps/client/app/settings/users/page.tsx:41` builds the dropdown as
`ROLES.map((role) => ({ value: role, label: role }))`, so both the option value
and its visible label come from the tuple. The sidebar renders `{me.user.role}`
directly (`apps/client/components/app-shell.tsx:128`). Again: confirm by grep,
do not assume.

Note this means the UI will read **"manager"** in lower case, exactly as it
reads "editor" today. Matching the existing presentation is the right call; a
capitalisation pass on role labels is a separate change and not in scope.

**`resources/openapi/linq.openapi.json`** — five places:

| Line | What |
|---|---|
| 7 | the intro's ``viewer < author < editor < admin`` ladder sentence |
| 676 | `PATCH /links/{id}` — "**editor** for any link" |
| 718 | `DELETE /links/{id}` — same sentence |
| 822 | `PUT /links/{id}/rules` — same sentence |
| 1725 | `components.schemas.Role.enum` |

**`resources/dbml/linq.dbml:26`** — the `Enum role` entry
`editor [note: 'Also manages any link.']`.

## 4. Docs

- `CONTEXT.md:20` — the canonical ladder sentence, both the `viewer < author <
  editor < admin` chain and the "editor also manages any Link" clause.
- `README.md` — no role mention to change (line 85's SQL snippet uses `admin`).
- No ADR names the role, so none needs a banner. The rename is a naming change,
  not a reversal of a recorded decision, so it gets no ADR of its own.

## 5. The cache sweeps — `apps/server/src/cache.ts`

Inside `memoryCache` (lines 133-168), alongside the existing `max`/`ttl`
construction, which is unchanged:

```ts
/** Never leave a lapsed entry holding a slot longer than this. */
const SWEEP_CEILING_MS = 60_000
```

```ts
// lru-cache never removes stale entries on its own: they keep their slot and
// keep counting toward `max`, so a store full of lapsed keys evicts live ones.
// Expiry is already checked on access, so this changes no answer — only how long
// a dead entry occupies a slot.
//
// Sweeping on the TTL bounds that: an entry outlives its expiry by at most one
// period. Capped at a minute so a long TTL still reclaims promptly. No floor is
// needed — LINQ_CACHE_TTL is min(1) second in config, so this cannot go below
// 1000 ms.
//
// One timer for the whole store, not `ttlAutopurge`: that arms a timeout per
// cached entry, up to `max` of them, and pays a clearTimeout + setTimeout on
// every write — which is the redirect's miss path.
const sweepMs = Math.min(ttl * 1000, SWEEP_CEILING_MS)
const purge = () => store.purgeStale()
const sweep = setInterval(purge, sweepMs)
sweep.unref?.()
```

and `stop` clears it before emptying the store:

```ts
stop: () => {
  clearInterval(sweep)
  store.clear()
},
```

`unref?.()` follows the pattern the deleted geo timer used: the sweep must never
be the reason the process stays alive.

Add `sweepMs` to the existing boot line (`cache.ts:150`), beside `ttl` and
`max` — it is derived rather than configured, so naming it is the only way an
operator can see what it resolved to.

No empty-store guard. `purgeStale` iterates live entries (`#rindexes`), so an
empty store costs zero iterations; a guard would buy nothing and read as though
it did. No logging per sweep either: `purgeStale` returns whether it deleted
anything and nothing acts on it.

**This partly reverses Plan_13**, which deleted a 60-second sweep timer when it
replaced the sqlite store. Worth being straight about: what Plan_13 deleted was
a sweep that *implemented* expiry, in a store where nothing else did. This one
implements nothing — expiry already works on access — and only returns memory.
The two are not the same timer wearing the same name.

### Making it observable

A purge changes nothing visible through the `Cache` interface: expiry is already
checked on access, so every `get` returns the same answer either way. The only
observable is how many entries are still held — and `Cache` has no `size`.

Do **not** add optional members to the shared `Cache` type for this. An optional
`size?()` that two of three backends leave undefined is a hole: a caller who
assumes it gets `undefined is not a function` instead of a type error.

Widen `memoryCache`'s own return type instead, leaving `Cache` alone:

```ts
export function memoryCache(config: Config): Cache & {
  /** Entries held, lapsed ones included until a sweep. For tests and debugging. */
  size(): number
} {
```

`size()` returns `store.size`, and — verified against `lru-cache@11.5.2` — that
count **includes lapsed entries** until something reclaims them. That is what
makes it the right observable: with no sweep it stays at 2 past the TTL, so the
test below fails against the old code.

`startCache` still returns `Cache`, so nothing downstream widens and no other
backend changes. `apps/server/test/cache.test.ts:178` already calls
`memoryCache` directly, so the suite picks `size()` up with full typing and no
cast.

**Do not also expose `purge()`.** The first draft of this plan did, so a test
could trigger a sweep on demand. It cannot: `sweepMs` equals the TTL for any TTL
under a minute, so by the time an entry is stale the timer has already swept it,
and an explicit `purge()` finds nothing and returns `false`. Exposing it would
add public surface with no caller outside the timer.

## 6. The local `.env`

Untracked and gitignored, so none of this appears in the diff — but it is what
the running instance actually reads.

- **Add** `LINQ_CACHE_TTL=300`, and `LINQ_CACHE_MAX_ENTRIES=10000` commented out,
  mirroring how `.env.example` presents them.
- **Remove** `LINQ_GEO_ENABLED` and `LINQ_TRUST_PROXY`. Both settings were
  deleted in Plan_14. They are silently ignored today — `loadConfig` builds a
  non-strict `z.object` over `process.env`, which must tolerate unknown keys —
  so they are misleading rather than harmful, which is the worst kind of stale
  config: it reads like it is doing something.

`.env.example` needs no change. It already documents all four cache settings and
already ships `LINQ_CACHE_TTL` uncommented.

## 7. Tests

All under `apps/server/test/`. `apps/client/test/` has no role references.

Mechanical `editor` → `manager`, including two test *titles* in `links.test.ts`:

| File | Lines |
|---|---|
| `permissions.test.ts` | 20-22 (ladder table), 34-35, 50-52, 75-92, 119 |
| `auth.test.ts` | 31, 35 |
| `users.test.ts` | 33, 69-71, 92, 121-126 (incl. a local `const editor` variable) |
| `links.test.ts` | 146-149, 170-174 — two titles say "an editor edits any link" |
| `domains.test.ts` | 14-15, 127-129 |
| `rules.test.ts` | 176, 186 |
| `purge.test.ts` | 53-54 |

`test/helpers/app.ts:29` — `actor: (role: Role)` is typed off `Role` and needs
no change.

**One new test** in `cache.test.ts`, in the `describe("the memory backend")`
block beside the existing TTL case at line 215:

```
"the sweep reclaims a lapsed entry nothing has touched"
```

Open with `ttl = 1`, write two keys, assert `size()` is 2, `Bun.sleep(2200)`,
then assert `size()` is **0** — **without either key having been read**, since a
read reclaims on access and would prove nothing about the sweep.

Staleness and the sweep cannot be separated in time: `sweepMs` **is** the TTL
below a minute, so any wait long enough to expire an entry is long enough for
the timer to have swept it. That rules out the tempting shape of asserting
`size()` is still 2 mid-way. The test is therefore an integration one — timer
and purge together — and it still fails against the old code, because `size()`
counts lapsed entries and would read 2.

The 2.2 s wait is against a 1 s TTL: expiry lands at 1 s and the sweep that
clears it at 2 s, so the assertion sits comfortably past both rather than racing
the boundary where they coincide. Do **not** add a `sweepMs` parameter to tighten
it: that is a production knob invented for a test, and what would be under test
is `setInterval`.

Keep `cache.test.ts:215` ("an entry past its TTL reads as a miss, with no sweep
run") **unchanged and green** — it is what proves the sweep did not become the
mechanism.

## Sequencing

1. **§1**, the shared package. Renaming the tuple and deleting `RANK` makes
   every remaining site a type error, which is the checklist for the rest.
2. **§2**, schema and migration.
3. **§3**, the OpenAPI and DBML artifacts, plus the grep that confirms the
   server and client genuinely needed nothing.
4. **§7** role renames in tests, then `bun test`.
5. **§5**, the cache sweep and its one new test. Independent of 1-4; could be
   done first.
6. **§4** and **§6**, docs and the local `.env`.

## Verification

1. `bun run typecheck`, `bunx biome check .`, `bun test` — all green.
2. `git grep -n "editor"` returns only the `RulesEditor` component, ARIA
   `role=` attributes, and frozen `plans/`. Nothing in `packages/shared`,
   `resources/`, or `CONTEXT.md`.
3. **The migration against a database that already holds an `editor` user** —
   a fresh database proves nothing here, since `RENAME VALUE` would have no row
   to carry. Seed a user with `role = 'editor'` under the pre-`0007` schema, run
   `0007`, then confirm `select role from users` reads `manager` and
   `select enum_range(null::role)` is
   `{viewer,author,manager,admin}` — in that order, which is what keeps
   `roleAtLeast` honest.
4. Confirm PGlite accepts `ALTER TYPE … RENAME VALUE`; the suite runs on it, so
   a green `bun test` is the proof, but it is the one statement in this plan
   whose PGlite support has not been exercised before.
5. End to end: mint a key for a `manager` user, `PATCH` a link owned by someone
   else (expect 200), and `DELETE /:id/purge` (expect 403 — purge is admin only).
   Then `POST /api/v1/users` with `{"role":"editor"}` and expect a 400 naming
   the field: the old name must be gone from the contract, not merely unused.
6. The cache sweep: start the server with `LINQ_CACHE_TTL=1` and confirm the
   boot line reads `sweepMs: 1000`; then with the default TTL and confirm it
   reads `sweepMs: 60000`. Hit a slug, wait past the TTL, and confirm redirects
   still serve — the sweep must be invisible in behaviour. Then `SIGTERM`: the
   process must exit promptly, which is what proves the interval is cleared and
   unref'd.
7. In the UI, the users page role dropdown offers viewer / author / manager /
   admin, and the sidebar shows `manager` for such a user.

## Risks

- **`ALTER TYPE … RENAME VALUE` has no down-migration**, in a repo that has
  none by convention. Reversing means writing the opposite statement by hand.
  Low stakes — it rewrites no data — but worth saying out loud.
- **It is a breaking API change.** Any stored client, script or saved request
  sending `"role": "editor"` starts getting a 400. Nothing has shipped, so this
  is a decision rather than an incident, but the failure lands on the caller and
  says only that the enum did not match.
- **Deleting `RANK` is a behaviour-preserving change that is not free of
  judgement.** `ROLES.indexOf` returns `-1` for a value outside the tuple, so a
  role that somehow bypassed validation would compare as *less* privileged than
  every real role rather than throwing — which fails closed, and is why the
  swap is safe. The `RANK` map would have returned `undefined` and made every
  comparison false, which is also closed. Neither can happen while `roleSchema`
  guards the boundary; this is only about which way the floor tilts.
- **The sweep does not lower peak memory.** The cap still bounds it. What
  changes is how long lapsed entries hold slots — at most one sweep period past
  expiry, instead of until something walks past them. Anyone expecting a lower
  ceiling will not see one.
- **The interval now moves with `LINQ_CACHE_TTL`.** An operator who drops the
  TTL to a second also gets a sweep every second: a full walk of up to
  `LINQ_CACHE_MAX_ENTRIES` that often. At 10 000 entries that is still only a
  few thousand time comparisons, but it is a cost that follows a setting whose
  documentation says nothing about sweeping, so the boot line naming `sweepMs`
  is the only place it is visible.
- **`memoryCache` now returns more than `Cache`.** `size()` exists for the test
  and for debugging. `startCache` still hands back a plain `Cache`, so nothing
  downstream can reach it by accident — but one backend's concrete type is now
  wider than the interface, and a second backend offering the same would want it
  promoted to `Cache` properly rather than widened again.
- **The sweep is only testable as an integration.** Because its period equals
  the TTL, no test can observe the un-swept state, so nothing pins the lazy
  behaviour the sweep replaces. If the interval ever stops tracking the TTL, the
  existing test still passes while the gap it was written for quietly reopens.
