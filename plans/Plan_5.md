# Rename the entity `Link` → `Link`

## Context

The repo collides two meanings of one word. **Link** is the product — the package
scope, the env prefix, the API-key prefix, the Docker image, the log file. But
`CONTEXT.md:5` also defines **Link** as *"one short link. A Slug on a Domain,
owned by a User"* — the core domain entity.

The product keeps its name. The thing it creates is a **link**. Every identifier,
table, route, type and piece of UI copy that means "one short link" becomes
`link`/`Link`; everything that means "the service" stays `link`.

This is a vocabulary correction, not a behaviour change. No logic moves.

## The boundary

The split is mechanically reliable because the product forms are distinctive:

| Stays `link` (product) | Becomes `link` (entity) |
|---|---|
| `@linq/shared`, `@linq/server`, `@linq/admin`, root `"name": "link"` | table `links`, column `link_id` |
| all 17 `LINQ_*` env vars | `/api/v1/links`, `/admin/links/` |
| `linq_` API-key prefix (`auth/keys.ts:7`) | `type Link`, `LinkCreate`, `LinkPatch`, `link*Schema` |
| `linq.apiKey`, `NEXT_PUBLIC_LINQ_API`, `LINQ_DEV_API` | `linkId`, `linkCount`, `toLink`, `loadLink`, `fetchLink`, `insertLink`, `linkQuery`, `findActiveLink`, `linkRoutes`, `linkStatsRoutes`, `assertNo*Links` |
| `data/logs/linq.log`, DB name/user `link`, compose service + volumes | `can.createLink` / `editLink` / `transferLink` |
| brand copy: `<h1>link</h1>`, `"link admin"`, app-shell header, `"Starts with linq_."` | UI copy: "Links", "New link", "Back to links", "No links match…" |
| `admin-static.test.ts:69` assertion on `"name": "link"` | span names `link.fetch/load/insert/findActive` |

### Three traps — a blind case-insensitive sweep breaks all three

1. **`LINQ_*` env vars sit inside entity code.** `http/api/links.ts:145,149,210`
   uses `LINQ_SLUG_LENGTH`, including the user-visible string
   `"could not allocate a free slug; raise LINQ_SLUG_LENGTH"`. Same in
   `test/redirect.test.ts` (`LINQ_TRUST_PROXY`) and `test/log.test.ts`.
2. **`linq_` API-key prefix is persisted** in `api_keys.prefix` and asserted in
   `keys.test.ts` / `bootstrap.test.ts`. Renaming it invalidates every issued key.
   Leave `auth/keys.ts` untouched.
3. **The DB rename is a migration, not an edit.** `drizzle/0000_init.sql` and
   `0001_*.sql` are applied history. See below — drizzle-kit will emit
   DROP+CREATE unless the SQL is hand-written.

## Decisions taken

- **DB**: new `0002` migration with `ALTER … RENAME`. `0000`/`0001` stay untouched.
- **API**: clean break to `/api/v1/links`. No `/links` alias.
- **Docs**: rename across all docs including `plans/Plan_1..4.md` and `docs/adr/*`.

## Files

### 1. Shared contracts — do these first, the compiler drives the rest

`packages/shared/src/links.ts` → **`links.ts`**

- `linkCreateSchema` → `linkCreateSchema`, `LinkCreate` → `LinkCreate`
- `linkPatchSchema` → `linkPatchSchema`, `LinkPatch` → `LinkPatch`
- `linkListQuerySchema` → `linkListQuerySchema`
- `type Link` → `type Link`

Then `index.ts:4` export path, and the entity tokens in `clicks.ts:33,40`
(`linkId`), `domains.ts:23` (`linkCount`), `rules.ts:39` (`linkId`),
`errors.ts:48` (`notFound("link")` → `notFound("link")`), `roles.ts:19` comment,
and `permissions.ts` (`createLink`/`editLink`/`transferLink` + doc comments).
Leave `permissions.ts:10` and `primitives.ts:9` — both mean the service.

### 2. Schema + migration

`apps/server/src/db/schema.ts` — `links` → `links` (table const and `"links"`
name), `linkId: uuid("link_id")` → `linkId: uuid("link_id")` on both `rules:99`
and `clicks:114`, the four `links_*` index names, `rules_link_position_key`,
`clicks_link_occurred_idx`, and `schema` export at `:137`.

Run `bun run db:generate` for the snapshot, then **replace the generated SQL
body** — drizzle emits DROP+CREATE for a table rename, which destroys data. Keep
the generated `meta/0002_snapshot.json` (it describes the end state, which is
correct either way) and hand-write `drizzle/0002_links_to_links.sql`:

```sql
ALTER TABLE "links" RENAME TO "links";
ALTER TABLE "rules"  RENAME COLUMN "link_id" TO "link_id";
ALTER TABLE "clicks" RENAME COLUMN "link_id" TO "link_id";

ALTER TABLE "links"  RENAME CONSTRAINT "links_domain_id_domains_id_fk" TO "links_domain_id_domains_id_fk";
ALTER TABLE "links"  RENAME CONSTRAINT "links_owner_id_users_id_fk"    TO "links_owner_id_users_id_fk";
ALTER TABLE "rules"  RENAME CONSTRAINT "rules_link_id_links_id_fk"     TO "rules_link_id_links_id_fk";
ALTER TABLE "clicks" RENAME CONSTRAINT "clicks_link_id_links_id_fk"    TO "clicks_link_id_links_id_fk";

ALTER INDEX "links_pkey"              RENAME TO "links_pkey";
ALTER INDEX "links_domain_slug_key"   RENAME TO "links_domain_slug_key";
ALTER INDEX "links_owner_id_idx"      RENAME TO "links_owner_id_idx";
ALTER INDEX "links_status_idx"        RENAME TO "links_status_idx";
ALTER INDEX "links_tags_idx"          RENAME TO "links_tags_idx";
ALTER INDEX "rules_link_position_key" RENAME TO "rules_link_position_key";
ALTER INDEX "clicks_link_occurred_idx" RENAME TO "clicks_link_occurred_idx";
```

Notes: Postgres does **not** rename constraints or indexes when a table is
renamed, hence the explicit statements. `clicks_orphan_occurred_idx` needs no
rename — its name carries no `link`, and its `WHERE link_id is null` predicate
follows the column rename automatically. Add the file to `meta/_journal.json`.

### 3. Server

`apps/server/src/http/api/links.ts` → **`links.ts`** (90 hits) — `toLink`,
`linkQuery`, `fetchLink`, `loadLink`, `insertLink`, `linkRoutes`, span names
`link.fetch|load|insert|purge`, `{ in: { linkId } }` log fields,
`ApiError.notFound("link")`. **Keep `LINQ_SLUG_LENGTH` at `:145,149,210`.**

`http/app.ts:13,16,58-61` — imports and the four mounts → `v1.route("/links", …)`.
Leave the `:24` comment ("everything link answers itself") — that's the service.

Then `redirect.ts` (`findActiveLink`, span `link.findActive`, local `link`),
`api/rules.ts`, `api/clicks.ts`, `api/stats.ts` (`linkStatsRoutes`),
`api/domains.ts` (`linkCount`, subquery alias `link_counts`, `assertNoLinksAtAll`,
`assertNoActiveLinks`, and the two error strings *"domain still has links…"* /
*"…active links…"*), `admin-static.ts:26-28`, `auth/permissions.ts:15-28`
(including the message *"only an admin transfers a link it does not own"*),
`rules/store.ts`, `rules/match.ts:35`, `clicks/record.ts:18,22`, `log.ts:216`.

Untouched: `config.ts`, `bootstrap.ts`, `main.ts`, `slug.ts`, `auth/keys.ts`,
`auth/middleware.ts`, `clicks/geo.ts`, `http/validate.ts`, `drizzle.config.ts`.

### 4. Admin UI

`apps/admin/app/links/` → **`app/links/`** (`page.tsx`, `new/page.tsx`,
`detail/page.tsx`). Rename components (`LinksPage`, `LinksList`, `LinkDetail`,
`NewLinkForm`), every `/v1/links` fetch and `/links/` href, `linkId` props, and
all visible copy: heading `"Links"`, `"New link"`, `"Back to links"`,
`"No links match these filters."`, `"Create link"`, `"Could not create the link."`,
the purge warning, and *"Only an admin, or the owner, may hand a link over."*

Also `app/page.tsx:27,40` (`router.replace("/links/")` — but keep the `<h1>link</h1>`
brand, the `linq_` hint and placeholder), `components/app-shell.tsx:25,74,129-131`
(nav label and hrefs — keep the `:75` brand), `components/rules-editor.tsx`
(`linkId` prop, `/v1/links/…/rules`, the `:124` copy), `app/domains/page.tsx`
(the "Active links" column, `domain.linkCount`, two warning strings — keep the
`:186` hint *"Point its DNS at link."*), `app/orphans/page.tsx:15,36`,
`components/stats-panel.tsx:38`, `components/tag-picker.tsx:28,30,33`.

Leave `lib/api.ts` entirely (`linq.apiKey`, `NEXT_PUBLIC_LINQ_API`),
`next.config.ts`, `layout.tsx`.

### 5. Tests

`apps/server/test/links.test.ts` → **`links.test.ts`**. Entity tokens across
`purge`, `rules`, `stats`, `redirect`, `domains`, `permissions`, `log` suites and
`helpers/app.ts` (`createLink` helper → `createLink`, `POST /api/v1/links`).

`admin-static.test.ts:31,32,36` — the hardcoded export page list
`["links","links/new","links/detail",…]` → `links*`. **Keep `:69`**, which asserts
`package.json` is not served by checking for `"name": "link"`.

Leave `helpers/db.ts` (13 `LINQ_*` keys), `bootstrap.test.ts`, `geo.test.ts`,
`keys.test.ts`, `auth.test.ts`, `users.test.ts`, and every `LINQ_*` in `log.test.ts`
and `redirect.test.ts`.

### 6. Docs

`CONTEXT.md` — the live glossary. `:5` becomes **`**Link**: one short link…`** and
every Link/Links reference in the Slug, Domain, Destination, Rule, Orphan Click,
Tree, Item, OG Preview, Role, Archived and Purge entries follows. Keep `:1` and
`:3` (the *product's* glossary).

`docs/adr/0002-archive-instead-of-delete.md:7,11,23,27,28` (entity + the
`DELETE /api/v1/links/:id/purge` route + `clicks.link_id`), `0003:11`.
Keep `0003:7`, `0004`, `0005` — all `LINQ_*` and service references.

`plans/Plan_1..4.md` — rename entity tokens (glossary `Plan_1.md:13-28`, schema
`:100-114`, route table `:125-139`). Leave the env table at `:176-182`.

`README.md` needs nothing: it already says "short link" throughout, and its every
`link` is the product.

### 7. Rebuild artifacts

`apps/admin/out/` is committed. Run `bun run build:admin` and delete the stale
`out/links/` and `out/_next/static/chunks/app/links/` directories.

## Verification

```bash
bun run typecheck      # the compiler catches the bulk of a partial rename
bun test               # 15 suites; PGlite runs the real migrations, so 0002 is exercised
bun run lint
```

Then the boundary check — this must return **nothing**:

```bash
grep -rniE "link" --include="*.ts" --include="*.tsx" --include="*.sql" --include="*.md" . \
  | grep -v node_modules | grep -vE "\.next/|/out/" \
  | grep -viE "LINQ_[A-Z]|@linq/|linq_|link\.log|link\.apiKey|\"name\": \"link\"|# link|link admin|postgres://linq|link listening|linq-data|linq-geo"
```

Every surviving line is either a missed rename or a product reference that
belongs on the allowlist — decide which, one at a time.

Migration rehearsal against a real database with data (PGlite starts empty, so it
proves the SQL parses, not that it preserves rows):

```bash
psql -U postgres -d link -c '\d links'          # table, indexes, constraints all `links_*`
psql -U postgres -d link -c 'select count(*) from links;'   # row count unchanged
```

End-to-end, after `bun run dev` + `bun run dev:admin`:

1. `POST /api/v1/links` creates a link; `GET /api/v1/links` returns 404.
2. The short URL still redirects and records a click against `clicks.link_id`.
3. Admin UI at `/admin/links/` lists, creates, edits and archives; the nav says
   "Links"; the rules editor and stats panel load on the detail page.
4. Domains page shows the "Active links" count and blocks archiving a domain that
   still has active links.

## Note

Per the repo convention, this plan should also land as `plans/Plan_5.md` before
implementation starts.
