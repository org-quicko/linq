# linq — Plan 31: QR codes, and the links list view brought to the design

Follows `docs/plans/Plan_27.md` (the restyle) and `docs/plans/Plan_30.md` (the summary
view this plan removes).

---

## Context

Two unrelated asks, sharing one file.

**1. There is no QR code surface at all.** `docs/plans/Plan_1.md:139` parked a
`GET /api/v1/links/:id/qr.svg` endpoint as "P2" and it was never built. Nothing
in the repo mentions QR today. A short link's whole point is being handed to
someone — printed, on a slide, on a poster — and that hand-off is a QR code.
The ask is a QR code that is *always* attached to a short link, a list view to
manage them, and create/edit in dialogs. No summary page.

**2. The links list view has drifted from the design.**
`claude/design/Variant — Domains moved into Settings-html/DomainsInSettings.dc.html`
is the reference artboard. The implementation at `apps/client/app/links/page.tsx`
diverges in ~25 places. Two of them are not cosmetic:

- **The row has no way to reach analytics.** The design's row carries a
  bar-chart icon button that opens Analytics pre-filtered to that link. The app
  has no such CTA, and `apps/client/app/analytics/page.tsx` has no link filter
  it could target — `AnalyticsOverview` keeps the selected link in component
  state (`analytics-overview.tsx:43-44`), unreachable from a URL.
- **The row's primary click goes to `/links/{id}/summary/`, a page the design
  does not have.** In the design, drilling into a link *is* the analytics page
  filtered to it. The summary view is removed.

The rest is visual: a generic glyph where the design shows the destination's
favicon, 16px type where the design says 14px/12.5px, pill-shaped filled tag
chips where the design specifies outlined square-ish ones, a card-wrapped
5-column filter grid where the design has a bare toolbar, and no relative
timestamp on the destination line.

Decisions taken with the user before writing this plan:

| | |
|---|---|
| QR storage | A separate `qr_codes` table, `link_id` NOT NULL |
| QR logo | Not in v1 |
| Design fidelity | Match the mockup exactly — **except** pagination becomes infinite scroll, not "no pagination" |
| Summary view | Deleted. The row is not clickable; the analytics icon button is the only drill-down |

---

## Part A — QR codes

### A0. The library

**`qr-code-styling@1.9.2`** — one transitive dependency (`qrcode-generator`),
no peer dependencies. It is the only QR library that covers what this feature
needs in one piece: styled dots and corners, themeable colors, and PNG / JPEG /
SVG export straight from the browser. `qrcode` and `qrcode.react` render a plain
black-and-white matrix and would leave the styling to be written by hand.

The options object:

```js
{ width: 1080, height: 1080, data: <shortUrl>,
  qrOptions: { errorCorrectionLevel: "Q" }, margin: 0,
  dotsOptions:          { color: dotColor, type: <per pattern> },
  cornersSquareOptions: { color: dotColor, type: <per pattern> },
  cornersDotOptions:    { color: dotColor, type: <per pattern> },
  backgroundOptions:    { color: bgColor } }
```

Error correction `Q` (25%) rather than the `M` default: a QR with brand colors
and a low-contrast palette needs the headroom, and it is what leaves room to add
a centre logo later without re-rendering every stored code.

Three patterns, collapsing the library's dot/corner-square/corner-dot triple
into one choice a person can actually make:

| Preset | `dotsType` | `cornerSquareType` | `cornerDotType` |
|---|---|---|---|
| `squares` | `square` | `square` | `square` |
| `rounded` | `rounded` | `extra-rounded` | `dot` |
| `dots` | `dots` | `dot` | `dot` |

Downloads: PNG, JPEG, SVG (`instance.download({ name, extension })`).

**Nothing is rendered or stored server-side.** The QR encodes the link's
`shortUrl`, which the API already returns (`links.ts:53-56`), so the encoded
data is derived, never persisted — rename a domain and every QR follows.
The server stores only the styling.

### A1. `packages/shared/src/qr-codes.ts`

Following `links.ts` and `domains.ts`: zod schemas plus a hand-written response
type, both exported from `index.ts`.

```ts
export const QR_PATTERNS = ["squares", "rounded", "dots"] as const
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/)

export const qrCodeCreateSchema = z.strictObject({
  linkId: uuidSchema,                         // required — a QR is never free-floating
  name: z.string().trim().min(1).max(120).nullish(),
  dotColor:  hexColor.default("#000000"),
  bgColor:   hexColor.default("#ffffff"),
  pattern:   z.enum(QR_PATTERNS).default("squares"),
})
export const qrCodePatchSchema = qrCodeCreateSchema.omit({ linkId: true }).partial()
export const qrCodeListQuerySchema = paginationSchema.extend({
  linkId: uuidSchema.optional(),
  search: z.string().trim().optional(),
})

export type QrCode = {
  id: string
  linkId: string
  name: string | null
  dotColor: string
  bgColor: string
  pattern: (typeof QR_PATTERNS)[number]

  // The link's, carried along so a list row renders without a second request.
  linkName: string | null
  linkStatus: "active" | "archived"
  /** The `api_keys.id` that owns the *link* (ADR 0011: the key is the
   *  principal). A QR code has no owner of its own. Null when the owning key
   *  was revoked. Present for one reason — see below. */
  linkOwnerId: string | null
  slug: string
  domainHost: string
  shortUrl: string

  createdAt: string
  updatedAt: string
}
```

**On `slug` / `domainHost` / `shortUrl` being unprefixed:** that is deliberate,
so `QrCode` structurally satisfies `ShortLinkLike` (`patterns/short-link.tsx:7`)
and a row renders `<ShortLink link={qrCode} />` with no adapter object. It is
the one place the structural trick pays for itself, because `ShortLink` is
reused across the app.

**`linkOwnerId` is prefixed, and does not get the same treatment.** It would be
tempting to spell it `ownerId` so `QrCode` also satisfies `Owned`
(`permissions.ts:7`) and `can.editLink(actor, qrCode)` typechecks directly. Do
not. On a QR code, a bare `ownerId` reads as the QR's own owner, which does not
exist — and it would be inconsistent with `linkName` / `linkStatus` two lines
up. The structural saving is one expression at one call site, which is not
worth a field name that lies. The single consumer writes the adapter and reads
better for it:

```ts
can.editLink(actor, { ownerId: qrCode.linkOwnerId })
```

That spelling also says the true thing out loud: the question is not "may you
edit this QR code", it is **"may you edit the link it belongs to"**.

**Why the field exists at all** — one reason, and it is worth being honest that
it is a thin one. It gates the row's `⋮` menu, so the UI stops offering an edit
the server will refuse. That is a courtesy, not a gate: the server reads
`link.ownerId` off the joined row in `loadQrCode` and never trusts this field,
exactly as `permissions.ts:17` describes. Without it the alternative is showing
every action to everyone and surfacing a 403 toast, which is worse.

**Not `apiKeyId`.** The referent is `api_keys.id`, but on a `QrCode` that name
reads as "this QR's API key", which means nothing. What the field holds is the
link's owner; that an owner *is* an API key is ADR 0011's domain fact, and the
doc comment is where it belongs.

**No `ownerName`, deliberately**, though `Link` has one and mirroring `toLink`
would put it here. Nothing renders it: the QR row shows a swatch, a name, the
short link and the pattern. In the whole client `Link.ownerName` has two
consumers, both in `summary-client.tsx` — the file Part C deletes. Carrying it
would also be the *only* reason `qrCodeQuery` joins `api_keys` at all. Add the
field and the join together, if a row ever shows an owner.

`linkId` is omitted from the patch schema deliberately: `linkPatchSchema` is
`.strictObject().partial()` so an immutable field is a 400, not a silent ignore
(`links.ts:37-50`). Re-pointing a QR at a different link would invalidate every
printed copy — same reasoning that freezes `slug`.

Colors are stored as hex strings rather than tokens: a QR is exported to PNG and
printed, so it must not follow the app's theme.

### A2. Schema and migration

`apps/server/src/db/schema.ts`, using the module-level `createdAt`/`updatedAt`
consts (`:23-24`) and registering in the `schema` export (`:223-231`):

```ts
export const qrCodes = pgTable("qr_codes", {
  id: uuid("id").primaryKey(),
  linkId: uuid("link_id").notNull()
    .references(() => links.id, { onDelete: "cascade" }),
  name: text("name"),
  dotColor: text("dot_color").notNull().default("#000000"),
  bgColor: text("bg_color").notNull().default("#ffffff"),
  pattern: qrPatternEnum("pattern").notNull().default("squares"),
  createdAt, updatedAt,
}, (t) => [index("qr_codes_link_id_idx").on(t.linkId)])
```

Plus `export const qrPatternEnum = pgEnum("qr_pattern", ["squares","rounded","dots"])`
alongside the three existing enums (`:19-21`).

`NOT NULL` + `ON DELETE CASCADE` is the whole of "a QR code is always associated
with a short link" — the database enforces it, no application check can drift
from it. Cascade rather than restrict because a link is only ever hard-deleted
by purge (`links.ts:365-378`), and a QR for a purged link is meaningless.

`bun run db:generate`, then rename to `0018_qr_codes.sql` and update the
`tag` in `drizzle/meta/_journal.json` to match — the repo's naming convention
(`0014_link_expiry`, `0015_link_listed`, `0017_drop_bot_label`). Add the
why-comment header, the one sanctioned hand-edit:

```sql
-- QR codes for short links. The encoded data is not stored: it is always the
-- link's current short URL, so renaming a domain re-points every printed code.
-- Only the styling lives here. See docs/plans/Plan_31.md.
```

Never touch the generated DDL itself.

### A3. `apps/server/src/http/api/qr-codes.ts`

Mounted top-level — `v1.route("/qr-codes", qrCodeRoutes)` in `app.ts:71-83` —
because the list view spans every link. Permissions delegate to the parent link.

**`rules.ts` is the precedent to follow**, not `links.ts`: it is the repo's other
child-of-a-link resource, and it already establishes both halves of what this
needs — `loadLink(db, id)` then `assertCanEdit(c.var.principal, link.ownerId)`
(`rules.ts:39-41`), and a **plain hard delete, no archive**. ADR 0002's
archive-instead-of-delete exists so a purged slug stays taken; a QR row has no
slug and no redirect, so archiving it would be ceremony with no consequence.

Structure, mirroring `links.ts` exactly:

- `idParam` — `validate("param", z.object({ id: uuidSchema }))`
- `toQrCode(row)` — the one serializer, hand-mapped, dates `.toISOString()`d
- `qrCodeQuery(db)` — `innerJoin(links).innerJoin(domains)`, and **no
  `leftJoin(apiKeys)`**: `links.ts` has one only to resolve `ownerName`, which
  A1 drops. Inner joins because `link_id` is NOT NULL behind a foreign key, so
  neither can drop a row. `shortUrl` is built by the same
  `shortUrl(host, slug)` helper `links.ts:53-56` uses, so a code and its link
  can never disagree about what it points at. Both it and `loadLink` are
  already exported from `links.ts` — `rules.ts:11` imports `loadLink` the same
  way.
- `fetchQrCode` / `loadQrCode`, both wrapped in `span(...)` from `src/log.ts`.
  `loadQrCode` returns the QR *and* its link in one query, since every
  permission check needs the link's `ownerId`.
- one chained `new Hono<Env>()`:
  - `GET /` — `validate("query", qrCodeListQuerySchema)`, `Page<QrCode>` envelope
    (`{data,total,limit,offset}`), ordered by `createdAt desc` with `qrCodes.id`
    as the UUIDv7 tiebreak.
    **The `count()` query must repeat the `innerJoin(links)`**, unlike the one
    in `links.ts:176-224`: `search` filters on `links.name` and `links.slug`, so
    a count over the bare table would disagree with the page it describes. The
    join cannot change the number — `link_id` is NOT NULL with an FK.
  - `POST /` — `loadLink` the target **first** (an unknown link is a 404, not a
    permission question), then `assertCanEdit`, then
    **409 if the link is archived** — its short URL does not resolve, so the
    code would be born dead and someone would print it. `id: Bun.randomUUIDv7()`,
    `201`.
  - `GET /:id`
  - `PATCH /:id` — `loadQrCode` → `assertCanEdit(principal, link.ownerId)` →
    `updatedAt: new Date()`. A blanket `...patch` spread **is** safe here,
    unlike `links.ts:306-308`: every patchable field is a string the column
    takes as-is (no `expiresAt`-style ISO/Date mismatch) and the schema is
    strict, so nothing unknown can reach the update.
  - `DELETE /:id` — `assertCanEdit`, hard delete, `c.body(null, 204)`. No
    `/purge` route.

**No cache invalidation.** `cache.del(linkKeys(...))` exists because links sit on
the redirect path (`src/cache.ts:52-55`). QR rows are never read by the redirect
handler or by `/llms.txt`, so there is nothing to invalidate.

**Skipped:** `sort` / `order` / `domainId` query params. The list is newest-first
and filterable by link and text; add pickers when one page of filters stops
being enough.

### A3b. Permissions — there is nothing to add

Worth stating explicitly, because the obvious move is to add a predicate and it
would be wrong.

A QR code's permission is not its own — it *is* its link's. So the existing
rule already answers it, on both sides:

- **Server:** `assertCanEdit(principal, link.ownerId)`, off the link row
  `loadQrCode` already returns. Called four times in the route file. No
  `assertCanEditQrCode` wrapping one call in another function.
- **Client:** `can.editLink(actor, { ownerId: qrCode.linkOwnerId })`, once, on
  the row.

A `can.editQrCode` would be an alias for `can.editLink` under a second name — a
second spelling of one rule, in the file that exists so there is only one.
`can.editLink` compares `actor.keyId === link.ownerId`, and both sides of that
are `api_keys.id`; a QR code changes nothing about the comparison.

The only edit is one line of prose on `can.editLink`'s doc comment
(`packages/shared/src/permissions.ts:42`), so the next reader knows it covers
QR codes too.

Note that **create is gated on `can.editLink` against the target link**, not on
`can.createLink`. An author must not be able to hang rows off a manager's link.

### A4. Client

**`apps/client/lib/qr.ts`** — the only file that knows the library's option
names. It exports `qrOptions(config, size)` returning the object in A0, and
`downloadQr(config, filename, extension)`. Keeping the pattern→types map here
means the *stored* config stays linq's vocabulary rather than a copy of a
library's API, and swapping renderers later is this one file.

**`apps/client/lib/store/qr-codes.ts`** — `apiSlice.injectEndpoints`, typed off
the shared types, same `providesTags`/`invalidatesTags` shape as `links.ts`.
Add `"QrCode"` to `tagTypes` in `lib/store/api.ts:38`.

One easily-missed line in `lib/store/links.ts`: **`purgeLink` must also
invalidate `{ type: "QrCode", id: "LIST" }`.** The server's `ON DELETE CASCADE`
destroys the QR rows, and without this the list keeps rendering a row whose
link no longer exists. `archiveLink` does not need it — the row is still real,
just badged.

**`apps/client/app/qr-codes/page.tsx`** — `AppShell` render-prop with `actor`,
`PageHeader` + "Create QR code", a debounced search `Input` (`useDebounced`, as
on the links page), `Collection variant="list"`, `Pager`. No `generateStaticParams`
is needed: there is no dynamic segment, so `output: "export"` emits
`/qr-codes/index.html` and no `admin-static.ts` fallback is required either.

Each row is a `RowCard`:

- **Tile: a colour swatch, not a live QR.** `RowCardTile` with the QR's own
  `bgColor`/`dotColor` and a `QrCode` glyph. A 40px QR is unreadable, and
  rendering one per row costs a library instance and an SVG render per row to
  convey nothing. The swatch still shows the styling at a glance.
- Name, then `<ShortLink link={qrCode} />` — which works with **no adapter
  object** because of A1's field naming.
- `⋮` with Edit / Delete. Delete uses `ConfirmButton`
  (`common.tsx:311-394`), and its copy has to be honest:
  *"This deletes the saved styling. Printed codes keep working — archive the
  link itself to stop it resolving."*

**No row click-through, and `ShortLink` takes no `href`.** Part C deletes
`/links/{id}/summary/`, so the destination every other `ShortLink href` in the
app currently points at will not exist. The row's copy button (built into
`ShortLink`) is the through-line to the short link.

**Nav** — `components/app-shell.tsx:39-43`, a fourth `NAV` entry after Short
links: `{ href: "/qr-codes/", label: "QR codes", icon: QrCode, visible: () => true }`.
`QrCode` is in `lucide-react`. Note `activeHref` (`:69`) is longest-prefix, so
`/qr-codes/` does not collide with `/links/`.

**`components/qr-form-dialog.tsx`** — create and edit in one component, keyed
`${mode}-${id}` at the call site to force a remount, exactly as
`link-form-dialog.tsx` is used at `app/links/page.tsx:178-187`. One `useState`
per field, submit through `useRun()` (`lib/hooks.ts:80-102`) for the
saving/toast/close behaviour, `disabled` on the submit button rather than a
form library — the repo has no react-hook-form and no client-side zod.

Layout: the **preview leads**, at the top of the scrolling body — it is the
point of the dialog, and putting it above rather than beside the fields keeps it
in view as the form scrolls. Under it, the three download buttons (PNG / JPEG /
SVG). Then the fields:

- **Short link** — required, and **disabled in edit mode** (A1 freezes
  `linkId`). Use the `LinkFilter` combobox: `analytics-overview.tsx:122-188`
  already implements exactly this against `useListLinksQuery({search, limit: 8})`,
  so lift it into `patterns/link-filter.tsx` rather than writing a second one.
  Filter to `status: "active"` — the server returns 409 for an archived link,
  so offering one is offering an error.
- **Title** — optional, as on links.
- **Two colour fields** — a native `<input type="color">` swatch fused to a
  text input in one bordered control. No colour-picker dependency; the text
  half is what makes a brand hex pasteable, which the native swatch alone does
  not allow.
- **Pattern** — a three-way `Picker`.

In create mode the preview's `shortUrl` comes off the picked link, so it is live
before anything is saved; in edit mode it is on the record.

### A5. Driving an imperative library from React

`qr-code-styling` is imperative: it is handed a DOM node and writes into it. So
React owns the container and nothing inside it — the `<div>` is rendered empty
on purpose, and its children are the library's.

```tsx
const host = useRef<HTMLDivElement>(null)
const instance = useRef<QRCodeStyling | null>(null)

useEffect(() => {
  let cancelled = false
  const options = { ...qrOptions({ shortUrl, dotColor, bgColor, pattern }, size), type: "svg" as const }

  void (async () => {
    const { default: QRCodeStyling } = await import("qr-code-styling")
    if (cancelled || !host.current) return
    if (instance.current) instance.current.update(options)
    else {
      instance.current = new QRCodeStyling(options)
      instance.current.append(host.current)
    }
  })()

  return () => { cancelled = true }
  // The primitives, never a `config` object — a fresh literal each render would
  // re-run this on every unrelated keystroke in the form.
}, [shortUrl, dotColor, bgColor, pattern, size])
```

Three things this shape buys, each for a reason:

- **One instance across renders, `update()` after the first.** Constructing a
  new one per change tears the node down and rebuilds it, which visibly
  flickers while someone is dragging a colour.
- **Safe under React strict mode's double-invoke.** The guard is
  `instance.current`, so the second pass updates rather than appending twice;
  and a first pass cancelled before its import resolves never constructs.
- **SVG for the preview, canvas for PNG/JPEG downloads.** SVG is crisp at any
  CSS size with no `devicePixelRatio` handling. The renderer type is fixed at
  construction, so `downloadQr` builds a throwaway instance with the type the
  extension needs and never appends it. *Check at implementation whether one
  instance covers all three formats in 1.9.2; if it does, drop the throwaway.*

**On `output: "export"`.** I checked the published 1.9.2 tarball directly: the
only bare `window` in the bundle is `this._window = window` **inside the
constructor**, and nothing touches `window`, `document` or `navigator` at module
scope. So a top-level static import would *not* break `next build` — the module
evaluates cleanly during prerender as long as `new QRCodeStyling()` only ever
runs in an effect.

The dynamic `import()` above is still the right call, for a different reason:
it keeps ~50KB of QR renderer out of the initial bundle of every page that
loads the shell. `lib/qr.ts` uses `import type { Options }`, which is erased.
**No `next/dynamic`, no `ssr: false`, no `typeof window` guard** — all three
would be solving a problem that measurement says is not there.

Extract as `components/qr-preview.tsx` taking `{ config, size }`, with
`role="img"` and an `aria-label` of the encoded URL. Its only consumer is the
dialog — the list tile is a swatch, not a render.

### A6. Tests — `apps/server/test/qr-codes.test.ts`

`createHarness()` from `test/helpers/app.ts`; `h.actor(role)`, `h.createDomain`,
`h.createLink`, `h.post`, `h.patch`, `h.request`.

**POST**
1. An author creates one on its own link → 201, defaults applied (`#000000`,
   `#ffffff`, `squares`), `shortUrl` equal to the link's, and
   `linkName`/`slug`/`domainHost`/`linkStatus` present so a row renders without
   a second call.
2. No `linkId` → 400 — the "always attached" rule at the API edge.
3. Unknown `linkId` → 404, **and still 404 with a viewer key** — an unknown
   link is not a permission question.
4. An author on another key's link → 403. A viewer → 403. A manager → 201.
5. Bad hex (`"red"`, `"#12345"`, `"000000"`) → 400. Unknown pattern → 400.
6. An archived link → 409.
7. One link carries two codes, both in the list — the 1:N the separate table
   exists for.

**GET**
8. The page envelope, and `?linkId=` narrows to one link.
9. **`search` matches the QR's name *and* the link's name and slug** — this is
   the test that catches a `count()` that forgot to join `links`, which is the
   exact bug `links.ts` warns about.
10. Unknown id → 404; malformed id → 400.

**PATCH**
11. Colours, pattern and name update; `updatedAt` moves.
12. `linkId` in the body → 400, and the row still points at the original link.
13. An author on another key's link → 403.

**DELETE**
14. → 204, then `GET /:id` → 404 and it is gone from the list.
15. The link itself is untouched — still 200, still active.
16. `DELETE /:id/purge` → 404, asserting ADR 0002 was deliberately *not*
    extended here.
17. **Purging the parent link destroys its QR codes** — the `ON DELETE CASCADE`,
    asserted through the API rather than trusted from the DDL.

One client-side check, `apps/client/test/qr.test.ts` — `qrOptions` is pure and
its only library import is type-only, so this needs no DOM: each pattern maps to
its three option types; the encoded value is always the short URL at `Q` and
margin 0; the dot colour drives the corners too, so a code is never accidentally
two-tone. Nothing beyond that — `apps/client/test/servers.test.ts` is the only
existing client test and there is no component test surface to invent.

### A7. Hand-maintained artifacts

All hand-written mirrors, and every prior plan treats updating them as part of
the work, not follow-up:

- `resources/openapi/linq.openapi.json` — the five `/v1/qr-codes` operations and
  the `QrCode` / `QrCodeCreate` / `QrCodePatch` schemas, in the file's existing
  house style. The `delete` description carries the reasoning below.
- `resources/dbml/linq.dbml` — the `qr_codes` table, `Enum qr_pattern`, the
  `Ref … [delete: cascade]`, the index, the `routing` `TableGroup`, **and the
  table count in the `Project` note** (seven → eight), which goes stale silently.
- `CONTEXT.md` — a **QR Code** glossary entry. Terms only, no implementation.

**A short amendment to `docs/adr/0002`, rather than a new ADR.** A new table for
a feature is routine and needs no ADR of its own. But 0002 is
archive-instead-of-delete, a reader will assume it covers every resource, and
this is the first resource it does not cover — so the answer belongs where they
will look for it:

> QR codes are deleted, not archived, and have no purge. The decision above
> protects two things a QR code does not have: a reserved slug, and a visit
> history. Deleting one removes a saved appearance; it cannot hijack anything,
> and it loses no analytics — a scan is an ordinary visit on the link.
> `qr_codes.link_id` is `ON DELETE CASCADE` for the same reason. What a delete
> does *not* do is invalidate a printed code: the link is what resolves it, so
> archiving the link is still the only way to take one down.

(The favicon question in B2 is the one thing in this plan that wants a full ADR
of its own.)

### A8. Pre-existing doc drift found along the way

Not this plan's to fix, but recorded because two of the files above are being
edited anyway and someone will otherwise copy the wrong thing:

- **`docs/adr/0002`'s purge amendment is stale.** It says purging a link keeps
  its clicks as orphan clicks because `clicks.link_id` is `ON DELETE SET NULL`.
  `schema.ts` has `visits.linkId` as `onDelete: "cascade"`, and `links.ts`'s
  purge comment says the opposite ("a link's own traffic is destroyed, not
  reclassified"). Two lines, and this plan is already amending that file.
- **`resources/dbml/linq.dbml` has the same drift plus more** — `Ref: visits.link_id
  > links.id [delete: set null]`, a `visits` table missing `os` and `browser`,
  and `Enum visit_dimension` listing five values where `schema.ts` has seven.
- **`CONTEXT.md` is ahead of the code** — it glosses a link `kind`
  (`redirect | tree`), plus `Tree`, `Item` and `OG Preview`, none of which exist
  in `schema.ts` or the API. Write the QR entry against the code, not against
  its neighbours.

Say the word and any of these fold into this plan's doc pass; otherwise leave
them.

---

## Part B — The links list view

### B1. The row — `apps/client/app/links/page.tsx:192-318`

Target anatomy, from `DomainsInSettings.dc.html:756-804` and `.link-row`
(`:205-214`):

```
┌──────┐  Pricing Page  lnq.to/pricing  ⧉            [📊] [⋮]
│favicon│  ↳ quicko.com/pricing?utm… · 2d ago
└──────┘  [Marketing] [Website]
```

| Change | From | To |
|---|---|---|
| Analytics CTA | absent | `IconButton icon={BarChart3} label="View analytics"` → `/analytics/?linkId={id}` |
| Row click | `router.push('/links/{id}/summary/')` (`:220`) | removed — row is not clickable |
| Name / short path | `NextLink` + `underline-offset-2 hover:underline` (`:261-268`) | plain `<span>`s, no link, no underline |
| Type scale | ambient 16px / weight 500 | name `text-sm font-semibold`, short path `text-[12.5px] font-medium text-foreground` |
| Tile | `bg-muted` + `<Link2>` (`:214-218`) | 40px box, `border` + transparent, destination favicon `<img>` with 6px padding; `<Globe>` glyph instead when the link has rules |
| Destination line | bare text (`:274`) | `<CornerDownRight className="size-3">` + destination + `·` + `<When iso={link.createdAt} relative />` |
| Dynamic routing | always prints `link.destination` | prints `Routes dynamically` when the link has rules |
| Tags | `Badge variant="secondary"` → a filled pill (`:278`) | new `Tag` pattern: outlined, `rounded-sm`, 11px, `text-muted-foreground`, `bg-background` |
| Status badges | `Archived` / `Expired` + `opacity-60` (`:219`, `:269-272`) | removed — this list only shows active links |
| Column spacing | `RowCard` `gap-0.5` (row-card.tsx:38) | 12px between the text block and the tag row; 4px inside the text block |
| Overflow trigger | inline `Button variant="ghost" size="icon" className="size-10"` (`:224-233`) | `IconButton` — it is the repo's own 40px row action and carries a tooltip, which the inline version does not |
| Archive | opens a confirm `Dialog` (`:288-315`) | unchanged — see *Deliberate deviations* |
| Row padding | `px-5 py-3.5` (row-card.tsx:32) | `px-5 py-3` (design: `12px 20px`) |

**Reuse, don't rebuild.** `IconButton` (`components/patterns/icon-button.tsx`)
is already the mockup's `.icon-btn` with a real Radix tooltip in place of its
CSS `::after`. `When` + `relativeTime` (`components/common.tsx`) already render
"2d ago" — `apps/client/app/archives/page.tsx:148-150` uses them in this exact
`RowCard` shape. `RowCard`'s `onClick`/`cursor-pointer` and the `stopPropagation`
wrapper on `actions` (row-card.tsx:30-45) become dead once the row stops being
clickable; drop the prop rather than leaving it unused.

**New:** `components/patterns/tag.tsx`. The design's `.tag` (`:222-226`) cannot
be reached by adding a `Badge` variant — `rounded-4xl` sits in `badge.tsx:7`'s
base class, ahead of any variant. And `components/ui/` is shadcn primitives that
"know nothing about linq" (per the directory's own convention), so the override
belongs in `patterns/`. It wraps `Badge variant="outline"` with
`rounded-sm bg-background text-[11px] text-muted-foreground`. Used by the links
list and `app/archives/page.tsx`.

### B2. The favicon tile — needs a decision

The design shows the *destination's* favicon (`:762-764`). The app has no
favicon anywhere, and the server does not expose one.

**Recommended:** `https://www.google.com/s2/favicons?domain={host}&sz=64` in a
plain `<img>`, with `onError` swapping in the existing `<Link2>` glyph so a
blocked or missing icon degrades to today's appearance.

**This is a privacy boundary and needs an ADR** (`docs/adr/0014-favicons-are-fetched-from-a-third-party.md`):
it puts a request to Google on the list render path and discloses every
destination hostname in a user's account to a third party, from their browser.
That is the kind of hard-to-reverse call `docs/adr/` exists for, and it sits
awkwardly beside `docs/adr/0013` (short links are published only by opt-in).

The zero-cost alternative is to keep the `Link2` glyph and accept one deviation
from the artboard. **Flagging this rather than deciding it** — say which you
want and the plan collapses to one line either way.

### B3. The toolbar — `page.tsx:107-157` vs design `:678-751`

The design's toolbar is a bare flex row, not a surface:

```
[🔍 Search links        ✕]  [🏷 Tag (2) ▾]  [🌐 Domain (1) ▾]        [Newest to Oldest ↓]
```

- Drop the `<Card><CardContent className="grid … lg:grid-cols-5">` wrapper
  (`:107-108`) for `flex items-center justify-between gap-3`, left cluster
  `gap-2`, sort pushed right.
- Search becomes a 300px × 36px bordered box with a leading `<Search>` glyph and
  a trailing clear `✕` when non-empty. **`components/ui/input-group.tsx` already
  exports exactly this** — `InputGroup` + `InputGroupAddon` (leading icon) +
  `InputGroupInput` + `InputGroupButton` (the clear `✕`). It is currently unused
  by any page. Do not hand-roll a bordered flex box. Placeholder becomes
  `Search links`.
- `DomainPicker` (`components/patterns/domain-picker.tsx`) goes from a
  single-select `Select` to a multi-select checkbox dropdown with a `<Globe>`
  icon and a `Domain (n)` label. **This changes the API contract** —
  `linkListQuerySchema.domainId` (`packages/shared/src/links.ts:67`) is a single
  `uuidSchema`. It becomes a comma-separated list parsed the same way `tags`
  already is (`links.ts:57-66`), and `links.ts:176-224`'s filter becomes
  `inArray`. `DomainPicker` has no other call site.
- `TagPicker` (`components/tag-picker.tsx`) keeps its cmdk popover but loses the
  row of removable `Badge` chips it renders below the control — the design has
  no counterpart. Label becomes `Tag (n)`.
- **Delete the status filter** (`:126-134`). Archived links live on
  `/archives/`. `linkListQuerySchema.status` stays on the server (the archives
  page uses it).
- **Sort collapses to one control**: a single outline button whose label is the
  option and whose trailing arrow is the direction. The design offers only
  *Newest to Oldest* / *Oldest to Newest* (`:2430-2433`) — both `createdAt`.
  Drop the Updated/Visits options and the detached direction button
  (`:135-155`). `sort` stays in `linkListQuerySchema` for API clients.

### B4. Infinite scroll, replacing `Pager`

The design has no pagination at all; the user asked for infinite scroll instead.

`@reduxjs/toolkit@2.12.0` is installed and ships `build.infiniteQuery`
(verified: `fetchNextPage` / `hasNextPage` / `isFetchingNextPage` are present in
`dist/query/react/index.d.mts`). Use it rather than hand-rolling page
accumulation in component state.

In `apps/client/lib/store/links.ts`, alongside the existing `listLinks`:

```ts
listLinksInfinite: build.infiniteQuery<Page<Link>, LinkFilters, number>({
  infiniteQueryOptions: {
    initialPageParam: 0,
    getNextPageParam: (last, _all, lastParam) => {
      const next = lastParam + last.limit
      return next < last.total ? next : undefined
    },
  },
  query: ({ queryArg, pageParam }) => ({
    path: `/v1/links${qs({ ...queryArg, limit: 25, offset: pageParam })}`,
  }),
  providesTags: …same per-id + LIST shape as listLinks…
}),
```

Rows are `data.pages.flatMap(p => p.data)`. The `{data,total,limit,offset}`
envelope (`links.ts:223`) already carries everything `getNextPageParam` needs —
no server change.

Keep `listLinks` as-is: `analytics-overview.tsx:136` and
`archives/page.tsx:69` both use it and neither wants infinite scroll.

The sentinel is a bare `<div ref>` after the list, observed with a native
`IntersectionObserver` calling `fetchNextPage()` when `hasNextPage &&
!isFetchingNextPage`. No library. Put it in `components/patterns/` as
`InfiniteSentinel` only if the QR list needs it too; otherwise inline it.

`Collection` (`components/patterns/collection.tsx:58`) needs `gap-2` → `gap-2.5`
(design: 10px) and nothing else — it already owns loading/error/empty.

`Pager` (`common.tsx:423`) stays; `components/visits-card.tsx:180` still uses it.

### B5. Pinned header, scrolling list

The design scrolls only the list (`.page-scroll`, `:296-302`); header and
toolbar stay put. Today the whole panel scrolls — `app-shell.tsx:187` puts
`overflow-y-auto` on the card and `:188` puts the padding on a single inner div.

```tsx
// app-shell.tsx:186-190
<main className="flex h-screen flex-1 flex-col p-4 pl-0">
  <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-card shadow-panel">
    <div className="mx-auto flex min-h-0 w-full max-w-[1080px] flex-1 flex-col">{children}</div>
  </div>
</main>
```

**Blast radius:** padding moves out of the shell and into each page, so
`app/analytics/`, `app/archives/`, `app/settings/*`, `app/dev/components/` and
the landing page each need their content wrapped in a
`flex-1 overflow-y-auto px-7 pb-6` region with a `shrink-0` header above it.
Each is a small diff, but there are six of them. If that is more churn than you
want right now, say so and this section drops — everything else in Part B stands
without it.

### B6. Page header — `page.tsx:96-105`

- `PageHeader` title `text-xl` → `text-[22px] tracking-[-0.01em]`
  (`patterns/page-header.tsx:28`). Shell-wide; every page's `h1` moves with it,
  which is what the design wants.
- Create button: default `Button` is `h-8 px-2.5 text-sm`; the design is
  `h-9 px-4 text-[13.5px]`. Add a leading `<Plus className="size-3.5">`.
- The design's `C` keyboard shortcut chip (`:672`) is **out of scope** — the
  shortcut does not exist and a badge advertising a shortcut that does nothing is
  worse than no badge. Say the word and it becomes a `useEffect` keydown listener
  plus a `kbd` span.

### B7. Empty state

`page.tsx:163` `"No links match these filters."` → `"No links match your
search."`; `patterns/empty-state.tsx:9` `text-sm` → `text-[13px]`.

### B8. Deliberate deviations from the artboard

Stated so they read as decisions rather than misses:

- **Permission gating stays.** The mockup always shows all three overflow items;
  the app gates them on `can.editLink` / `can.createLink` (`:222`, `:236-253`).
  The mockup has no permission model.
- **The archive confirm dialog stays** (`:288-315`). `docs/plans/Plan_27.md` Part B3
  deliberately made the list and the detail view agree on confirm-before-archive.
  Silently archiving on a menu click is a worse product, artboard or not.
- **Dark mode and the theme toggle stay.** The artboard is a light-mode-only
  static file; that is not a decision to remove a feature.
- **`--accent` and `--chart-2`** (`globals.css:72`, `:80-84`) are left alone.
  Nothing on this page reads `--accent`, and `--chart-2`'s amber is the
  deliberate human/bot contrast from `docs/plans/Plan_30.md`.
- **"Link pages"**, the sidebar entry in the mockup (`:614`), is an unbuilt
  feature, not a discrepancy.

---

## Part C — Deleting the link summary view

### C1. Client

Delete `apps/client/app/links/[id]/summary/page.tsx` and
`summary-client.tsx`.

Rewire every inbound reference:

| File:line | Now | Becomes |
|---|---|---|
| `app/links/page.tsx:220` | `RowCard onClick` → summary | prop removed |
| `app/links/page.tsx:262` | name `NextLink` | plain `<span>` |
| `app/links/page.tsx:268` | `ShortLink href` | `ShortLink` with no `href` |
| `app/archives/page.tsx:129` | row click → summary | removed; the row already carries Restore + Purge buttons (`:132-143`) |
| `app/archives/page.tsx:147` | `ShortLink href` | no `href` |
| `app/links/detail/page.tsx:25` | redirects to summary | redirects to `/analytics/?linkId={id}` |

`ShortLink` (`patterns/short-link.tsx:23-55`) needs **no change**: `href` is
already optional and it falls back to a plain `<span>` (`:49-51`), and it
already pairs the text with the design's copy button (`:52`). Dropping `href`
at both call sites is the whole edit. The only nit is size — `CopyButton` uses
`size="icon-xs"` (24px) where the design draws 20px (`:770`); pass a className
rather than adding a button size.

No component is orphaned by this: `StatsPanel`, `VisitsCard` and `RulesEditor`
all keep call sites on `/analytics/` and in `link-form-dialog.tsx`.

### C2. Server

- `apps/server/src/http/admin-static.ts:62-70` — delete the
  `/^\/links\/[^/]+\/summary\/?$/` fallback that served the pre-rendered
  template. Dead once the route is gone.
- `apps/server/test/admin-static.test.ts:59-65` — delete the matching test;
  `:42`'s page list drops `"links/detail"` only if that stub is also removed
  (it is not — it still forwards old bookmarks).
- `GET /api/v1/links/:id/stats` (`src/http/api/stats.ts`) **stays**. It loses
  its only client caller but remains a documented public endpoint.

### C3. Analytics deep link — `/analytics/?linkId={id}`

This is what makes the row's CTA work, and it does not exist today.

`components/analytics-overview.tsx` holds the selection in local state
(`:43-44`) and swaps the endpoint on it (`:46`). Seed it from the URL:

- Read `useSearchParams().get("linkId")` and use it as the initial `linkId`.
- `linkName` is not in the URL, so resolve it with
  `useGetLinkQuery(linkId || skipToken)` and feed the result into the existing
  `LinkFilter` label (`:122-188`). `skipToken` is already the pattern here —
  `link-form-dialog.tsx:92` uses it.
- Clearing the filter should `router.replace("/analytics/")` so the URL and the
  control do not disagree.
- `app/analytics/page.tsx` needs a `<Suspense>` boundary around whatever calls
  `useSearchParams`, or `next build` fails under `output: "export"`. The pattern
  is already in `app/archives/page.tsx:38` and `app/links/detail/page.tsx:12`.

**Scope note.** The mockup's analytics link filter is *multi-select* — it pools
several links into one aggregate (`:2044-2048`,
`analyticsLinkFilters` as an array). That is a change to the Analytics page and
to `/v1/links/:id/stats`, not to the links list, so it is **not** in this plan.
This keeps the existing single-select control and only makes it URL-addressable.

---

## Files

**New**
`packages/shared/src/qr-codes.ts` ·
`apps/server/src/http/api/qr-codes.ts` ·
`apps/server/drizzle/0018_qr_codes.sql` ·
`apps/server/test/qr-codes.test.ts` ·
`apps/client/test/qr.test.ts` ·
`apps/client/lib/qr.ts` ·
`apps/client/lib/store/qr-codes.ts` ·
`apps/client/app/qr-codes/page.tsx` ·
`apps/client/components/qr-form-dialog.tsx` ·
`apps/client/components/qr-preview.tsx` ·
`apps/client/components/patterns/tag.tsx` ·
`apps/client/components/patterns/link-filter.tsx` (lifted from `analytics-overview.tsx:122-188`)

**Deleted**
`apps/client/app/links/[id]/summary/page.tsx` ·
`apps/client/app/links/[id]/summary/summary-client.tsx`

**Modified**
`apps/client/app/links/page.tsx` (the bulk of Part B) ·
`apps/client/app/analytics/page.tsx` + `components/analytics-overview.tsx` (C3) ·
`apps/client/app/archives/page.tsx` (C1) ·
`apps/client/app/links/detail/page.tsx` (C1) ·
`apps/client/components/app-shell.tsx` (nav entry, B5, B6) ·
`apps/client/components/patterns/{row-card,collection,domain-picker,page-header,empty-state}.tsx` ·
`apps/client/components/tag-picker.tsx` ·
`apps/client/lib/store/{api,links}.ts` ·
`apps/client/package.json` (`qr-code-styling@1.9.2`) ·
`apps/server/src/db/schema.ts` · `apps/server/src/http/app.ts` ·
`apps/server/src/http/admin-static.ts` + `test/admin-static.test.ts` (C2) ·
`packages/shared/src/{index,links,permissions}.ts` (B3's multi-domain filter;
one doc-comment line on `can.editLink`) ·
`resources/openapi/linq.openapi.json` · `resources/dbml/linq.dbml` ·
`CONTEXT.md` · `docs/adr/0002` (amendment)

Plus the four pages that relayout if B5 goes ahead: `app/analytics/`,
`app/archives/`, `app/settings/*`, `app/dev/components/`.

---

## Sequencing

1. **Part C** first — deleting the summary view shrinks the surface Part B has
   to restyle, and B1's row changes touch the same lines as C1's.
2. **Part B** — the design pass. B5 (pinned header) last within Part B, since it
   is the one change that reaches other pages.
3. **Part A** — QR codes, independent of both. Can start in parallel; it shares
   only `app-shell.tsx`'s `NAV` array and `patterns/link-filter.tsx` with Part B.

---

## Verification

Per `AGENTS.md` and every prior plan:

```
bun run typecheck
bunx biome check .
bun test
bun --filter @linq/client build     # catches the output:"export" / useSearchParams trap
```

Read the generated migration SQL before committing it; do not hand-edit the DDL.

Manual, with `bun run dev` (needs Postgres — see `.claude/skills/linq-dev`):

1. `/links/` — rows show a favicon tile, name + short path + copy, a
   `↳ destination · N ago` line, outlined square tag chips. No Archived/Expired
   badges. No pagination controls.
2. Scroll to the bottom of a >25-link account — the next page loads without a
   click and the header and toolbar stay pinned.
3. Click a row's bar-chart button → lands on `/analytics/?linkId={uuid}` with
   the link already selected in the filter and the stats scoped to it. Clear the
   filter → URL drops the param.
4. Clicking the row body does nothing. Edit / Duplicate / Archive still work
   from `⋮`.
5. Navigate to `/links/{id}/summary/` directly → 404, not a blank hydrated page.
6. `/links/detail/?id={uuid}` still forwards, now to analytics.
7. QR: create from the list, confirm the preview renders and matches after a
   reload, scan it with a phone and land on the short link, download PNG and SVG
   and check both scan.

---

## Risks

- **B5 is the one change that leaves this feature.** Six pages relayout. If any
  regression appears, it will be a page whose content no longer scrolls or one
  that lost its padding — cheap to spot, cheap to revert independently.
- **B3's multi-select domain filter changes a public query parameter.**
  `domainId` goes from one uuid to a comma-separated list. Existing API callers
  passing a single id keep working; the parser must accept both.
- **B2 (favicons) is unresolved** and needs your call before implementation.
- **Infinite scroll has no keyboard or screen-reader path to page 2.** Ship an
  explicit "Load more" button behind the sentinel — visible when
  `hasNextPage`, activated by either the observer or a click — rather than a
  sentinel alone.
