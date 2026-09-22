# linq — Plan 32: link previews (favicon, title, description) from the destination

Resolves `docs/plans/Plan_31.md` §B2, which flagged the links-list favicon as
needing a decision before implementation and left the row rendering a
generic glyph. See `docs/adr/0014` for the decision and the reasoning behind
every safety measure below — this plan is the "how", the ADR is the "why and
what it costs".

---

## What's being built

1. `links` gains two columns: `description` (text, nullable) and `icon_url`
   (text, nullable). `name` already exists and is reused as the title.
2. `POST /api/v1/links` fetches the destination's `<head>` and fills
   `name`/`description` when the request didn't supply them, and `icon_url`
   always (there is no caller-supplied icon).
3. `PATCH /api/v1/links/:id` does the same, but only when the patch changes
   `destination` — an edit that leaves the destination alone has nothing new
   to fetch. `name`/`description` explicitly present in that same patch
   (`null` included, which clears them) are never overwritten by a fetch.
4. The links-list row shows the fetched favicon, falling back to today's
   glyph on a missing or broken image — the client-side half of Plan_31 §B2.

Not in scope: showing `description` anywhere in the client yet (only `name`
renders in the row today — see `apps/client/app/links/page.tsx:296`), a
manual "refresh preview" action, and periodic re-fetching of a destination
that changes its own title later. All three are additive if asked for; none
of them are implied by "retrieve and store on create/edit".

---

## A. Schema

`apps/server/src/db/schema.ts`, on `links` right after `name` (`:77`):

```ts
name: text("name"),
/** Filled from the destination's <head> when the request didn't supply one.
 *  See docs/adr/0014. */
description: text("description"),
/** The destination's favicon, resolved to an absolute URL. Never
 *  caller-supplied — always whatever the last fetch found, or null.
 *  See docs/adr/0014. */
icon_url: text("icon_url"),
```

Then `bun run db:generate` (needs `DATABASE_URL` — see `.claude/skills/linq-db-migration`),
rename the generated file to `0019_link_metadata.sql` following the existing
`00NN_description` convention (`0014_link_expiry.sql`, `0015_link_listed.sql`,
`0018_qr_codes.sql`), and update `apps/server/drizzle/meta/_journal.json`'s
`tag` to match. Read the generated SQL before committing — it should be one
`ALTER TABLE links ADD COLUMN ...` pair, nothing else. Never hand-edit it.

---

## B. `apps/server/src/link-metadata.ts` — the fetcher

New file, same shape as `Cache` (`cache.ts:14-19`) and `Caddy` (`caddy.ts:12-15`):
a one-method port, a no-op default, a `guarded` wrapper that a bad
implementation can never throw past.

```ts
export type Metadata = { name: string | null; description: string | null; icon_url: string | null }
export type MetadataFetcher = { fetch(destination: string): Promise<Metadata> }

const EMPTY: Metadata = { name: null, description: null, icon_url: null }

/** What runs when LINQ_FETCH_LINK_METADATA=false, and what the test harness
 *  defaults to — no test should make a real network call by accident. */
export const noMetadata: MetadataFetcher = { fetch: async () => EMPTY }

export function guarded(fetcher: MetadataFetcher): MetadataFetcher {
  return {
    async fetch(destination) {
      try {
        return await fetcher.fetch(destination)
      } catch (err) {
        reqLog().debug({ err, destination }, "link metadata fetch failed")
        return EMPTY
      }
    },
  }
}

export function startMetadata(config: Config): MetadataFetcher {
  return config.LINQ_FETCH_LINK_METADATA === "false" ? noMetadata : httpMetadataFetcher()
}
```

`httpMetadataFetcher()` is the real implementation, private to this file:

**Constants**: `TIMEOUT_MS = 4000`, `MAX_REDIRECTS = 3`, `MAX_BYTES = 1_000_000`
(1 MB — the `<head>` this cares about is a few KB; a megabyte is generous
headroom, not a target), `USER_AGENT = "linq-link-preview/1.0"`. Fixed
constants, not new `LINQ_*` config — nothing asked for these to be tunable,
and a fixed 4-second budget is simpler to reason about than one more env var
whose only effect is how long a create request can hang.

**`isBlocked(hostname): Promise<boolean>`** — the SSRF guard docs/adr/0014
describes. A literal IP is checked directly (`node:net.isIP`); a hostname is
resolved via `node:dns/promises`' `lookup(host, {all: true})` and every
returned address is checked, IPv4 and IPv6 both. Unresolvable → blocked
(fail closed). The blocklist is deliberately the practically dangerous
ranges — loopback, link-local (`169.254.0.0/16`, which is also where the
`169.254.169.254` cloud metadata endpoint lives), the three RFC1918 ranges,
`100.64.0.0/10`, and multicast/reserved — not an exhaustive transcription of
every IANA special-purpose range. A byte-range check on the parsed octets,
~15 lines; no dependency.

**`safeFetch(destination): Promise<Response | null>`** — manual redirect
loop, `isBlocked` checked before every hop is connected to (not just the
first), one `AbortSignal.timeout(TIMEOUT_MS)` shared across every hop in the
loop so retries can't extend the budget, `redirect: "manual"`, a
`user-agent` header identifying the fetch honestly rather than spoofing a
browser. More than `MAX_REDIRECTS` hops, a non-2xx final response, or a
blocked hop all return `null`.

**`readBoundedHtml(res): Promise<string | null>`** — bails immediately if
`content-type` doesn't include `text/html`; otherwise reads `res.body`
through `getReader()` chunk by chunk, cancelling the stream the instant the
running total passes `MAX_BYTES`, and decodes whatever was read (never more
than the cap) with `Buffer.concat(chunks).toString("utf-8")`.

**`parseMetadata(html, baseUrl): Metadata`** — one `HTMLRewriter`, following
the precedence in docs/adr/0014. Collects `og:title`/`og:description`,
`twitter:title`/`twitter:description`, the plain `<title>` text and
`<meta name="description">`, and `link[rel~="icon"]` /
`link[rel="apple-touch-icon"]`, into local variables — **not** resolved via
`??=` inside the handlers, because handlers fire in document order and a
page that happens to list `twitter:title` before `og:title` must not let
document order silently override the stated precedence. Precedence is
resolved once, after `.transform(html)` returns:

```ts
const name = ogTitle || twitterTitle || titleTag.trim() || null
const description = ogDescription || twitterDescription || metaDescription || null
const icon_url = resolveUrl(iconHref || appleIconHref || "/favicon.ico", baseUrl)
```

`baseUrl` is `res.url` (the final URL after every redirect Bun's `fetch`
already resolved for us on the winning response), not the original
`destination` — a relative `href="/icon.png"` must resolve against where the
page actually ended up, not where the request started.

`resolveUrl` is `new URL(href, baseUrl).toString()`, wrapped to return `null`
on a malformed `href` rather than throwing.

**Top level**:

```ts
async function fetch_(destination: string): Promise<Metadata> {
  const res = await safeFetch(destination)
  if (!res) return EMPTY
  const html = await readBoundedHtml(res)
  if (!html) return EMPTY
  return parseMetadata(html, res.url || destination)
}
```

(named `fetch_` internally to avoid shadowing the global; exported as the
`fetch` method on the returned `MetadataFetcher` object.)

---

## C. Wiring — following `Cache`/`Caddy` exactly

- **`apps/server/src/http/env.ts`**: `Env["Variables"]` gains
  `metadata: MetadataFetcher`.
- **`apps/server/src/http/app.ts`**: `AppDeps` gains `metadata?: MetadataFetcher`,
  defaulted to `noMetadata` and wrapped in `guarded(...)` exactly like
  `cache`/`caddy` (`app.ts:31-38`), then `c.set("metadata", safeMetadata)`
  alongside the others (`:41-44`).
- **`apps/server/src/main.ts`**: `const metadata = guarded(startMetadata(config))`,
  passed into `createApp(...)` next to `cache`/`caddy` (`:21-23`).
- **`apps/server/src/config.ts`**: one field, next to the other optional
  integrations —

  ```ts
  /** Set to "false" to stop linq's server from fetching any destination's
   *  <head> for a title/description/favicon. See docs/adr/0014. */
  LINQ_FETCH_LINK_METADATA: z.enum(["true", "false"]).default("true"),
  ```

  An enum of the two literal strings, not `z.coerce.boolean()` — that
  coercion treats the non-empty string `"false"` as truthy, which is exactly
  the footgun an opt-out flag cannot afford. `LINQ_CACHE_BACKEND` two fields
  up is the same instinct already.

- **`apps/server/test/helpers/app.ts`**: `HarnessOptions` gains
  `metadata?: MetadataFetcher`; `createApp({ ..., metadata: options.metadata ?? noMetadata })`.
  Every existing test keeps running with zero network calls, unchanged —
  `noMetadata` answers every `fetch()` with nulls, same as `noCache` answers
  every `get()` with a miss. Tests that need to assert enrichment behaviour
  inject a small fake (`{ fetch: async () => ({ name: "Fetched", ... }) }`)
  through this same option.

---

## D. `packages/shared/src/links.ts`

```ts
export const linkCreateSchema = z.object({
  ...
  name: z.string().trim().max(200).optional(),
  description: z.string().trim().max(500).optional(),
  ...
})

export const linkPatchSchema = z.strictObject({
  ...
  name: z.string().trim().max(200).nullable(),
  description: z.string().trim().max(500).nullable(),
  ...
}).partial()

export type Link = {
  ...
  name: string | null
  description: string | null
  icon_url: string | null
  ...
}
```

`description` mirrors `name` exactly — optional on create, nullable on
patch, same `!== undefined` presence check the handler already uses for
`name`. `icon_url` is **not** on either input schema: there is no caller
input for it, ever, by design (docs/adr/0014) — only `Link` carries it.

---

## E. `apps/server/src/http/api/links.ts`

**`toLink`** (`:61-85`): add `description: link.description, icon_url: link.icon_url,`
next to `name: link.name,`.

**`POST /`** (`:235-288`) — fetch before opening the transaction, not inside
it: the domain row's `FOR SHARE` lock (`:245-249`) must not sit open for up
to 4 seconds waiting on an unrelated destination server.

```ts
.post("/", validate("json", linkCreateSchema), async (c) => {
  assertRole(c.var.principal, "author")
  const body = c.req.valid("json")
  const fetched = await c.var.metadata.fetch(body.destination)

  const row = await c.var.db.transaction(async (tx) => {
    ...
    const linkRow = await insertLink(
      tx,
      {
        domain_id: body.domain_id,
        destination: body.destination,
        name: body.name ?? fetched.name ?? null,
        description: body.description ?? fetched.description ?? null,
        icon_url: fetched.icon_url,
        tags: body.tags,
        ...
      },
      ...
    )
    ...
  })
  ...
})
```

**`PATCH /:id`** (`:292-349`) — fetch only when `destination` is in the
patch, again before the transaction opens:

```ts
const fetched = patch.destination !== undefined
  ? await c.var.metadata.fetch(patch.destination)
  : null

await c.var.db.transaction(async (tx) => {
  await tx.update(links).set({
    ...(patch.destination !== undefined ? { destination: patch.destination } : {}),
    ...(patch.name !== undefined
      ? { name: patch.name }
      : fetched ? { name: fetched.name ?? existing.name } : {}),
    ...(patch.description !== undefined
      ? { description: patch.description }
      : fetched ? { description: fetched.description ?? existing.description } : {}),
    ...(fetched ? { icon_url: fetched.icon_url ?? existing.icon_url } : {}),
    ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
    ...
```

Reading this the way the existing lines around it already read: `patch.name
!== undefined` is "the caller told us what to do with the title" (their
value wins, `null` included — clearing it is a valid instruction and must
stick). The `else` branch only runs when the destination changed *and* the
caller said nothing about the title — that's the one case where the old
title (describing the *previous* destination) is actively wrong and worth
replacing, so it's a plain overwrite, not a fill-if-empty: `fetched.name ??
existing.name` prefers the fresh value but falls back to what was there
rather than blanking a real title just because this particular fetch found
nothing (docs/adr/0014's "a failed fetch is not an error"). `icon_url` has
no caller-supplied branch at all — it is always either freshly fetched or,
on a fetch that found nothing, left as it was.

No new race to reason about: the fetch happens before the transaction and
its result is folded into the same single `UPDATE` every other patched field
already goes through, so there is nothing here that isn't already covered by
that statement's normal atomicity. (An earlier draft of this plan considered
firing the fetch in the background after responding, with `COALESCE`-based
guards against a second edit landing mid-fetch — dropped once it was clear
the synchronous version needs none of that machinery. See docs/adr/0014's
consequences.)

Cache invalidation is unchanged — `cache.del(...linkKeys(...))` already runs
after this transaction (`:347`) and the fetched fields are part of it, not a
separate write.

---

## F. Client

**`apps/client/components/patterns/row-card.tsx`** — no change; `RowCardTile`
already accepts arbitrary children.

**`apps/client/app/links/page.tsx:251-256`** — the tile:

```tsx
<RowCardTile>
  {link.icon_url ? (
    <img
      src={link.icon_url}
      alt=""
      className="size-4"
      onError={(e) => { e.currentTarget.style.display = "none" }}
    />
  ) : null}
  {!link.icon_url ? (
    routesDynamically ? <Globe className="size-4" /> : <Link2 className="size-4" />
  ) : null}
</RowCardTile>
```

Hiding the broken `<img>` on error rather than swapping it for the glyph
with `useState` — the glyph is a fallback for "there is no icon to try",
`onError` for "there was one and it didn't load"; both end up rendering
nothing where the icon would be, which for a 16px row glyph reads the same
either way. This keeps the tile a plain function of props, no per-row state.
If the empty box on a broken icon looks wrong in practice once it's on
screen, swap in a `useState` fallback then — a one-line change here rather
than a reason to add the state pre-emptively.

**`apps/client/components/link-form-dialog.tsx`** — one field, mirroring
`name` exactly (`:80`, `:194-196`):

```ts
const [description, setDescription] = useState(link?.description ?? "")
```

```tsx
<Field label="Description" hint="Optional, for your own reference.">
  <Input value={description} onChange={(event) => setDescription(event.target.value)} />
</Field>
```

placed directly after the existing "Title" field. Wired into `submit()`
(`:108-157`) exactly like `name` is: `description: description.trim() ||
undefined` on create, `description: description.trim() || null` on edit.

---

## G. Hand-maintained artifacts

Per `docs/plans/Plan_31.md` §A7's convention — these go stale silently otherwise:

- **`resources/openapi/linq.openapi.json`** — `Link` (`:1957-1980`) gains
  `description` and `icon_url` in both `properties` and `required`, `name`'s
  shape (`:2005-2011`, nullable string, `maxLength: 200`) is the template for
  `description` (`maxLength: 500`); `icon_url` is `{"type": ["string",
  "null"], "format": "uri"}`, no `maxLength` — it's server-computed, not a
  capped user input. `LinkCreate` (`:2081-`) gains `description` matching
  `name`'s shape there too (`:2100-2103`, non-nullable optional string).
  `LinkPatch`'s schema (further down the file, not yet read in this plan —
  confirm its shape matches `linkPatchSchema` before editing) gains the
  nullable `description`.
- **`resources/dbml/linq.dbml`** — `Table links` (`:87-101`) gains
  `description text` and `icon_url text` after `name` (`:92`), each with a
  `note:` pointing at `docs/adr/0014` the way `listed` already points at
  `docs/adr/0013` (`:99`).
- **`CONTEXT.md`** — no entry. `description`/`icon_url` aren't new domain
  vocabulary, just two more fields on the existing **Link** term; the
  glossary documents terms, not schemas (`AGENTS.md`'s "Docs conventions").

---

## H. Tests — `apps/server/test/links.test.ts`

New `describe("link preview metadata")` block, harness built with an
injected fake so nothing here touches the network:

```ts
const fakeMetadata: MetadataFetcher = {
  fetch: async (destination) =>
    destination.includes("blocked")
      ? { name: null, description: null, icon_url: null }
      : { name: "Fetched title", description: "Fetched description", icon_url: "https://cdn.example/icon.png" },
}
const h2 = await createHarness({ metadata: fakeMetadata })
```

1. **Create, nothing supplied** → `name`, `description`, `icon_url` all come
   from the fetch.
2. **Create, `name` supplied, `description` omitted** → `name` is the
   caller's value untouched, `description` is the fetched one. (The
   asymmetric case that most directly proves the two fields are decided
   independently, not as an all-or-nothing pair.)
3. **Create against a destination whose fetch finds nothing** (`"blocked"` in
   the URL, per the fake above) → `name`/`description`/`icon_url` all null,
   and the create still succeeds — a failed fetch is never a failed create.
4. **Patch changing `destination`, `name`/`description` omitted** → both
   refresh to the newly fetched values, `icon_url` too.
5. **Patch changing `destination` and explicitly clearing `name` to `null`
   in the same request** → `name` stays `null` after the patch — the
   explicit clear wins over the fetch, proving the `!== undefined` branch
   and not just "was it falsy".
6. **Patch changing `destination` where the fetch finds nothing** → the
   *old* `name`/`description`/`icon_url` survive unchanged, not blanked —
   the `fetched.name ?? existing.name` fallback.
7. **Patch that does not touch `destination`** (e.g. only `tags`) →
   `name`/`description`/`icon_url` all unchanged, and — asserted via a
   metadata fake whose `fetch` throws if called — **the fetcher is never
   invoked at all** for this patch.

One test in a new `describe`, using the *real* `httpMetadataFetcher`
against `http://169.254.169.254/` and `http://127.0.0.1:1/` (a closed local
port, no real destination contacted) asserting both resolve to
`{ name: null, description: null, icon_url: null }` rather than throwing or
hanging — the one place this plan tests the SSRF guard itself rather than
the seam around it.

`LINQ_FETCH_LINK_METADATA=false` → `startMetadata` returns `noMetadata`:
one direct unit test on `link-metadata.ts`, no harness needed.

---

## Files

**New**
`apps/server/src/link-metadata.ts` ·
`apps/server/drizzle/0019_link_metadata.sql` ·
`docs/adr/0014-link-previews-fetch-the-destination-directly.md`

**Modified**
`apps/server/src/db/schema.ts` ·
`apps/server/src/config.ts` ·
`apps/server/src/http/env.ts` · `apps/server/src/http/app.ts` · `apps/server/src/main.ts` ·
`apps/server/src/http/api/links.ts` ·
`apps/server/test/helpers/app.ts` · `apps/server/test/links.test.ts` ·
`packages/shared/src/links.ts` ·
`apps/client/app/links/page.tsx` · `apps/client/components/link-form-dialog.tsx` ·
`resources/openapi/linq.openapi.json` · `resources/dbml/linq.dbml`

---

## Sequencing

1. **A** (schema/migration) first — everything else types against it.
2. **B–C** (fetcher + wiring) before **E** (route handlers) — the routes
   consume `c.var.metadata`, which doesn't exist until C wires it in.
3. **D** (shared schemas) can happen any time before **E** and **F**, both of
   which import from it.
4. **F** (client) and **G** (hand-maintained docs) last, independent of each
   other.
5. **H** (tests) alongside **E** — the new `describe` block is what proves E
   is right.

---

## Verification

Per `AGENTS.md` and every prior plan:

```
bun run typecheck
bunx biome check .
bun test
```

Read the generated migration SQL before committing it.

Manual, with `bun run dev` (needs Postgres — `.claude/skills/linq-dev`):

1. Create a link to a real page with Open Graph tags and no `name` —
   confirm the list row picks up its favicon, and `GET` the link back to
   confirm `name`/`description` were filled.
2. Create a link supplying `name` but not `description` — confirm `name`
   stays exactly what was typed and `description` is still fetched.
3. Edit a link's destination to a different real site, without touching the
   title field — confirm the favicon and title change to match the new
   destination.
4. Edit a link's title only, destination untouched — confirm the favicon
   doesn't change and no extra latency is felt on save.
5. Create a link pointing at `http://169.254.169.254/` — confirm the create
   still succeeds (fetch refused, fields left null) rather than hanging or
   erroring.
6. Set `LINQ_FETCH_LINK_METADATA=false`, restart, create a link with no
   `name` — confirm it comes back with `name`, `description`, `icon_url`
   all null and no delay.

---

## Risks

- **This is the server's first outbound fetch to a URL it did not choose.**
  `docs/adr/0014` is written specifically to carry that reasoning where the
  next person touching this code will look for it, including the one gap
  (DNS rebinding) left open on purpose.
- **Create/update latency now includes a network call**, bounded to 4
  seconds. If that turns out to be felt in practice, the fix is moving the
  fetch off the request path (see §E's note on the background-fetch design
  that was considered and dropped) — not raising or removing the timeout.
- **The favicon guess (`/favicon.ico` when no `<link rel="icon">` is
  present) is unverified** and can 404. Accepted because the client already
  needs an `onError` fallback regardless (a favicon can go stale or move
  after being fetched), so verifying it server-side would duplicate a check
  the client has to do anyway.
