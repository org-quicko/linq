# linq — Plan 17: the API key is the principal

Follows `docs/plans/Plan_16.md`.

## Context

linq has a `users` table whose rows never log in. A user holds a name, an email,
a role and a status; it acts only through API keys; and the only thing that ever
reaches a request handler from it is `role`. The key is already the credential —
the user is a box drawn around one or more keys, and that box is paying for
itself in a whole table, two foreign keys, a join on every authenticated
request, a second join on every link read, six API routes, a settings screen and
a test helper reached from 48 call sites.

Collapsing the two removes a layer without removing a capability. A Key gains a
name and a role and becomes the principal outright.

The second half is the first-boot behaviour. `bootstrap.ts:22-44` creates an
`admin` user and a key on any database whose `users` table is empty, generating
the secret when `LINQ_INITIAL_API_KEY` is unset and printing it to stdout. That
is a fallback that runs by surprise, in the one case where the operator is least
likely to be watching, and its recovery story is a copy-paste TypeScript snippet
in the README (`README.md:75-99`). It goes. A key is created deliberately, by a
command, or it is not created at all.

Three structural facts shape everything below:

- **`links.owner_id` is `ON DELETE RESTRICT` into `users`** (`apps/server/src/db/schema.ts:83-85`)
  and is `innerJoin`ed on every link read for `ownerName` (`apps/server/src/http/api/links.ts:85`).
- **`h.actor(role)`** (`apps/server/test/helpers/app.ts:88-91`) returns
  `{ userId, key }` and is reached from **48 call sites across 12 test files** —
  the widest blast radius in the suite.
- **The Client UI's server probe treats a missing `user` object in `/me` as
  "not a linq server"** (`apps/client/lib/servers.ts:218-224`), so the `/me`
  shape cannot change without changing that check in the same commit.

## Decisions

- **`users` is dropped entirely**, along with the `user_status` enum. `api_keys`
  gains `role`, and its existing `label` column is **renamed** `name` rather than
  joined by a second one — a key's human label and its name are the same idea.
- **A Key owns its links.** `links.owner_id` repoints at `api_keys.id`.
- **`owner_id` becomes nullable, `ON DELETE SET NULL`.** This is the one place
  two of the requirements collide: revocation is a real delete, and a key owns
  links, so under `RESTRICT` a leaked key could not be revoked until someone
  moved its links first. Security wins. Revocation always succeeds; the links
  survive, unowned, and an unowned link is editable by manager and admin and
  adoptable by transfer. **`linkQuery`'s `innerJoin` must become a `leftJoin`**
  or every unowned link silently disappears from every list.
- **All four roles stay.** `viewer < author < manager < admin` is unchanged, and
  `author` keeps its meaning because ownership survives — it is just a key's
  ownership now.
- **No status column on a key.** A key has a name, a role, an expiry and a
  revoke. The `disabled` state dies with `users`; a key you do not want is one
  you delete.
- **Bootstrap still mints and prints an admin key, but only when the instance
  has no keys at all.** The guard moves from "the `users` table is empty" to
  "the `api_keys` table is empty", which also makes revoking every key
  recoverable by restarting. `LINQ_INITIAL_API_KEY` is removed from config,
  `.env.example`, `docker-compose.example.yml` and the log redaction list: the
  secret is always generated, never pinned from the environment.
- **A CLI mints a key without a restart**, as the fallback to boot minting, and
  the logic is shared rather than duplicated — one `createApiKey(db, …)` with
  three callers: boot, the HTTP route and the command.
- **`/me` returns the key**: `{ id, name, role, prefix, expiresAt }`, with the
  client probe updated in the same change.
- **Transfer stays** as the answer to rotation: mint the new key, transfer the
  links, revoke the old one. No new rotate endpoint; the machinery already
  exists and only needs retargeting from users to keys.

---

## 1. Schema and migration `0009`

`apps/server/src/db/schema.ts`:

```ts
/** The principal. A key is the only thing that acts; there are no user rows. */
export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  role: roleEnum("role").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  prefix: text("prefix").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt,
  updatedAt,
})
```

and on `links`:

```ts
  ownerId: uuid("owner_id").references(() => apiKeys.id, { onDelete: "set null" }),
```

Delete the `users` table, `userStatusEnum`, and `users` from the `schema` export
(`schema.ts:211-220`).

**Migration `0009_key_is_the_principal.sql` must be hand-written.** As with
`0006` and `0007`, drizzle-kit diffs snapshots and will emit a drop-and-recreate
that destroys data and fails on the foreign keys. Generate for the journal and
snapshot, then replace the body:

1. `ALTER TABLE "api_keys" RENAME COLUMN "label" TO "name";`
2. `ALTER TABLE "api_keys" ADD COLUMN "role" "role";` — nullable for now.
3. `ALTER TABLE "api_keys" ADD COLUMN "updated_at" timestamptz DEFAULT now() NOT NULL;`
4. Backfill the role from the owning user:
   `UPDATE "api_keys" k SET "role" = u."role" FROM "users" u WHERE k."user_id" = u."id";`
5. `DELETE FROM "api_keys" WHERE "role" IS NULL;` — a key whose user vanished
   cannot be assigned a role, and a roleless principal must not exist. Then
   `ALTER TABLE "api_keys" ALTER COLUMN "role" SET NOT NULL;`
6. Repoint ownership. `links.owner_id` currently holds a **user** id; rewrite it
   to that user's oldest key, or null when the user had none:
   ```sql
   ALTER TABLE "links" DROP CONSTRAINT "links_owner_id_users_id_fk";
   ALTER TABLE "links" ALTER COLUMN "owner_id" DROP NOT NULL;
   UPDATE "links" l SET "owner_id" = (
     SELECT k."id" FROM "api_keys" k
     WHERE k."user_id" = l."owner_id"
     ORDER BY k."created_at" LIMIT 1
   );
   ALTER TABLE "links" ADD CONSTRAINT "links_owner_id_api_keys_id_fk"
     FOREIGN KEY ("owner_id") REFERENCES "api_keys"("id") ON DELETE SET NULL;
   ```
7. `DROP INDEX "api_keys_user_id_idx";` and
   `ALTER TABLE "api_keys" DROP COLUMN "user_id";`
8. `DROP TABLE "users";` then `DROP TYPE "user_status";`

Steps 4-6 are a **best-effort backfill, not a faithful one**: a user with three
keys has its links arbitrarily assigned to the oldest, and a user with none loses
ownership. That is acceptable because nothing has shipped; on an empty database
every one of those statements is a no-op. Say so in the migration's comment
rather than letting a reader assume it is exact.

## 2. Auth — `apps/server/src/auth/`

`middleware.ts` loses its join and its status check:

```ts
export type Principal = { keyId: string; role: Role; name: string }
```

```ts
  const [row] = await c.var.db
    .select({ keyId: apiKeys.id, name: apiKeys.name, role: apiKeys.role, expiresAt: apiKeys.expiresAt })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hashKey(token)))
    .limit(1)

  if (!row) throw ApiError.unauthorized()
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    throw ApiError.unauthorized("API key has expired")
  }
  c.set("principal", { keyId: row.keyId, role: row.role, name: row.name })
```

`name` rides along so `/me` needs no second query. `keys.ts` is untouched —
`generateKey`, `hashKey`, `keyPrefix` are all still exactly right.

`permissions.ts` keeps its four wrappers; only `assertCanEdit` and
`assertCanTransfer` change signature, to `ownerId: string | null`.

**New shared helper**, used by both the CLI and the HTTP route so the minting
rules exist once — `apps/server/src/auth/mint.ts`:

```ts
/** Creates a key and returns the plaintext secret, which is never recoverable. */
export async function createApiKey(
  db: Db,
  opts: { name: string; role: Role; expiresAt?: Date | null },
): Promise<{ row: typeof apiKeys.$inferSelect; secret: string }>
```

## 3. Shared package

- `packages/shared/src/users.ts` → **renamed** `keys.ts`. `userCreateSchema`,
  `userPatchSchema`, `User`, `UserSummary` are deleted. What remains and grows:
  ```ts
  export const keyCreateSchema = z.object({
    name: z.string().trim().min(1).max(100),
    role: roleSchema,
    /** ISO-8601. Absent means the key never expires. */
    expiresAt: z.iso.datetime().nullable().optional(),
  })
  export const keyPatchSchema = z.object({ name: …, role: roleSchema, expiresAt: … }).partial()
  export type ApiKey = { id: string; name: string; role: Role; prefix: string; expiresAt: string | null; createdAt: string; updatedAt: string }
  export type ApiKeySummary = { id: string; name: string }
  export type ApiKeyCreated = ApiKey & { secret: string }
  ```
- `packages/shared/src/roles.ts` — delete `USER_STATUSES`, `UserStatus`,
  `userStatusSchema`. `ROLES` and `roleAtLeast` are unchanged.
- `packages/shared/src/permissions.ts` — `Actor` becomes `{ keyId: string; role: Role }`,
  `Owned` becomes `{ ownerId: string | null }`, and the two identity comparisons
  become `actor.keyId === link.ownerId`. A null owner therefore never matches an
  actor, which fails closed by construction. Rename `manageUsers` → `manageKeys`,
  `disableUser` → `revokeKey`, and retarget `changeRoleOf` at a key id. Both
  self-guards keep their meaning: nobody changes their own role, nobody revokes
  their own key.
- `packages/shared/src/links.ts` — `Link.ownerId` and `Link.ownerName` become
  `string | null`.
- `packages/shared/src/index.ts` — swap the `users.ts` export for `keys.ts`.

## 4. Routes

**`apps/server/src/http/api/users.ts` is deleted.** Its `keyRoutes` half moves
into a new `apps/server/src/http/api/keys.ts` and grows the routes `userRoutes`
used to own. Drop the `/api/v1/users` mount from `app.ts:76`.

| Method | Path | Gate | Notes |
|---|---|---|---|
| `GET` | `/api/v1/keys` | any role | Same role-shaped response the users list had (`users.ts:60-78`): an admin sees the full `ApiKey`, everyone else sees `{ id, name }`. **Non-admins must not see `prefix` or `role`.** The UI needs this for the owner column and the transfer picker. |
| `POST` | `/api/v1/keys` | admin | The only response carrying `secret`. Calls `createApiKey`. |
| `GET` | `/api/v1/keys/:id` | admin | |
| `PATCH` | `/api/v1/keys/:id` | admin | Guard: `id === principal.keyId && patch.role !== undefined` → 403, the existing "nobody changes their own role" rule. |
| `DELETE` | `/api/v1/keys/:id` | admin | Guard: `id === principal.keyId` → 403. Revoking your own key is the lockout the old `disableUser` guard prevented. |

**`me.ts`** collapses to one row and no query at all — `Principal` now carries
`name` and `role`, so only `prefix` and `expiresAt` need fetching:

```ts
// { id, name, role, prefix, expiresAt }
```

**`links.ts`** — `linkQuery` (74-92): `users.name` becomes `apiKeys.name` and
**`.innerJoin` becomes `.leftJoin`**. Create (208) sets
`ownerId: c.var.principal.keyId`. The transfer probe (229-231) checks `api_keys`
instead of `users` and 404s `"key"`.

**`log.ts:234`** — `userId: principal?.userId` becomes `keyId: principal?.keyId`.

## 5. The CLI

`apps/server/src/cli/create-key.ts`, a thin wrapper over `createApiKey`:

```
bun run key:create --name ops --role admin [--expires 2027-01-01]
```

Argument parsing uses `parseArgs` from `node:util` — stdlib, no dependency. It
loads config, opens the database, calls `createApiKey`, prints the secret in the
same one-shot format the bootstrap used, and exits. `--role` defaults to
`admin`, since the overwhelmingly common use is the first key or a recovery key.

Scripts: `"key:create": "bun src/cli/create-key.ts"` in
`apps/server/package.json`, and `"key:create": "bun --filter @linq/server key:create"`
at the root, matching how `db:generate` is already wired.

It does **not** run migrations. On a database that has never started the server
the tables do not exist, and the Postgres error says exactly that.

## 6. Bootstrap and config

- `apps/server/src/bootstrap.ts` — delete `bootstrapAdmin` (22-44) and its
  import of `apiKeys`/`users`/`generateKey`. `bootstrap()` keeps only
  `seedDefaultDomain`. Its doc comment stops promising an admin.
- `apps/server/src/config.ts:28` — remove `LINQ_INITIAL_API_KEY`.
- `apps/server/src/log.ts:63` — drop it from `collectSecrets`.
- `.env.example:40-41`, the local `.env:11`, `docker-compose.example.yml:41-43` —
  remove the variable and its comments.

## 7. Client

- **`apps/client/app/settings/users/` → `settings/keys/`.** The page becomes a
  flat list of keys — name, role, prefix, created, expires — with mint, edit
  (name/role/expiry) and revoke. The nested `KeysPanel` expansion disappears,
  since there is no longer an outer row to expand; the two-step
  "create user then mint a key" in `AddUserDialog` (`page.tsx:339-353`) collapses
  into one mint.
- `apps/client/components/app-shell.tsx:128` — `{ keyId: me.id, role: me.role }`.
  The sidebar chip (167-191) reads the key's name instead of a user's.
  `can.manageUsers` → `can.manageKeys` in the nav (line 64), and the label
  "Users" becomes "Keys".
- `apps/client/lib/store/users.ts` → `keys.ts`; `Me` becomes the key shape;
  `listUsers`/`createUser`/`updateUser` become `listKeys`/`mintKey`/`updateKey`,
  and `listKeys(userId)`'s per-user tag becomes a flat `LIST`.
- `apps/client/lib/servers.ts:184-224` — `ProbeResult`'s `user` becomes the key,
  and **the linq-ness test at 220 must stop reading `body.user`**; check
  `body.role` instead. Without this every saved server fails to probe.
- Owner surfaces handle null: `links/page.tsx:199`, `links/trash/page.tsx:82`
  and `links/detail/page.tsx:75` render an em dash or "unowned" when `ownerName`
  is null; the owner `Picker` (detail 239-256) lists keys.
- `apps/client/app/page.tsx:31` — the landing copy describing users and sign-in.

## 8. Docs

- **New `docs/adr/0011-the-api-key-is-the-principal.md`.** There is no existing
  auth ADR, and this is the architectural decision of the change: why the user
  layer was redundant, why ownership moved to keys, why `SET NULL` beat
  `RESTRICT` (a leaked key must be revocable immediately), and why first-boot
  minting was removed in favour of a deliberate command. ADR 0006 already says
  "a key is the only credential linq issues" — this does not contradict it, and
  the new ADR should say so rather than superseding it.
- `CONTEXT.md` — delete **User**; rewrite **Key** as the principal (name, Role,
  optional expiry, revoked by deletion); **Role** loses "and Users"; **Link**
  becomes "owned by a Key" and must mention that a Link can be unowned.
- `README.md:52-99` — the whole first-boot section. No printed key; instead
  `bun run key:create`. The "lost the key" details block and its `mint-key.ts`
  snippet are deleted outright — that is now the same command.
- `resources/dbml/linq.dbml` — drop `Table users` (56-66), the `user_status`
  enum (30-33) and both Refs (220, 223); rewrite `api_keys` (68-82) and
  `links.owner_id` (105); update the project note (12) and `TableGroup identity`
  (239-242). Eight tables become seven.
- `resources/openapi/linq.openapi.json` — delete every `/users` path
  (1091-1367) and the `User`, `UserSummary`, `UserCreate`, `UserPatch` schemas
  (2233-2354); rewrite `/me` (102-157), the `/keys` paths (1369-1396) and
  `ApiKey`/`KeyCreate` (2355-2443); `Link.ownerId` and `Link.ownerName` become
  nullable (1848-1849, 1910-1919); drop the `ownerId` filter's user framing
  (495-506). Keep the tag name or rename it "Keys" consistently.

## 9. Tests

**The harness first** — `apps/server/test/helpers/app.ts:62-91`. `createUser` is
deleted; `createKey` takes `{ role, name?, expiresAt? }`; and `actor(role)`
returns **`{ keyId, key }`** instead of `{ userId, key }`. That rename is the
48-call-site change: most sites only use `.key`, but the ownership assertions in
`links.test.ts` and `purge.test.ts` destructure the id.

- `users.test.ts` → **`keys.test.ts`**, rewritten: list shape by role, mint
  returns the secret once, non-admin cannot mint or revoke, revoke stops the key
  working, the two self-guards (own role, own key), 404 on an unknown id.
- `auth.test.ts` — delete "rejects every key of a disabled user" (53-59); there
  is no disabled state. Update "accepts a valid key and reports the principal"
  (30-37) to the new `/me` shape.
- `bootstrap.test.ts` — rewritten. It currently asserts a key is minted; it must
  now assert the opposite: an empty database gets **no** key, and
  `seedDefaultDomain` still seeds and is still idempotent.
- `permissions.test.ts` — `principal` builder and the whole `can.*` matrix move
  to `keyId`. The doc at 60-64 explains the matrix is written out rather than
  derived, so it genuinely must be re-typed.
- `links.test.ts` — transfer tests retarget at keys, and **a new case: a link
  whose owner key was revoked still appears in the list with a null owner.**
  That is the `leftJoin` regression test, and it is the one most likely to be
  missed.
- **New**: a test for `createApiKey` covering the shared mint path, which is
  what gives the CLI coverage without driving a subprocess.

## Sequencing

Nothing typechecks until §1-§4 are all done; do not expect a green tree in
between.

1. **§1** schema and migration.
2. **§3** shared package — the types everything else follows from.
3. **§2** and **§4** auth, routes, links.
4. **§9** harness and server tests, then `bun test`.
5. **§5** and **§6** CLI and bootstrap.
6. **§7** client.
7. **§8** docs and the ADR.

## Verification

1. `bun run typecheck`, `bunx biome check .`, `bun test`.
2. **The migration against a database that already holds rows**: seed a user, a
   key, a domain and a link, then run `0009`. Confirm the link survives and is
   unowned, `api_keys` has `name`/`role` and no `user_id`, and `users` and
   `user_status` are gone. **A fresh database proves nothing here** — the
   statement that empties `links.owner_id` touches no rows on one, which is
   exactly how an ordering bug survives a green suite.
3. Boot against an **empty** database and confirm an admin key is printed once,
   then boot again and confirm it prints nothing and adds no second key.
4. Delete every key row, restart, and confirm a fresh one is minted — the
   "no keys, not never booted" guard.
5. `bun run key:create --name ops --role admin`, then use the printed secret:
   `GET /api/v1/me` returns that key's `{ id, name, role, prefix }`.
6. Mint a second key as `author`, create a link with it, then revoke that key as
   admin. The revoke must **succeed** (not 409), and the link must still be
   listed with a null owner and still redirect. This is the `SET NULL` decision
   end to end.
7. Rotation: mint a replacement, `PATCH` the link's `ownerId` to it, revoke the
   old key, confirm the link is still owned and still editable by the new key.
8. In the UI: the Keys page mints, edits and revokes; the sidebar shows the key
   name and role; a revoked key's links show an unowned owner cell; and a saved
   server still probes green, which is the `servers.ts` check.

## Risks

- **The ownership backfill is lossy.** A user with several keys has its links
  assigned to the oldest one arbitrarily, and a user with no keys loses ownership
  entirely. Harmless today because nothing has shipped, and irreversible on any
  database where it is not.
- **There is no way back in if every admin key is revoked** except the CLI, and
  the CLI needs shell access to the host. That is a deliberate trade — it is also
  exactly the recovery path the old README snippet provided, now supported
  instead of pasted.
- **Revocation is now genuinely destructive to ownership.** Under the old model
  disabling a user was reversible; a revoked key cannot be un-revoked, and its
  links do not come back to anyone when a replacement is minted. Transfer is the
  only path, and it has to happen before the revoke or an admin has to reassign
  afterwards.
- **`leftJoin` changes list semantics.** Every link list previously guaranteed
  an owner; now `ownerName` can be null anywhere it is rendered. Any surface that
  forgets it shows "undefined" rather than failing loudly.
- **Losing `users` loses email.** Nothing read it except the users screen, but
  it is the only contact information the system held, and there is now nowhere to
  put "who is this key for" beyond the name.
- **Every stored client key keeps working, but every saved server breaks its
  probe** until the client is redeployed, because the linq-ness test reads
  `body.user`. Client and server must ship together.
- **A key's name is not unique and not verified.** Two keys called "ops" are
  indistinguishable in the owner column, where two users called "ops" were at
  least distinct rows someone had to deliberately create.
