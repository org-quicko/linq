# linq — Plan 27: restyle the Client UI to the "Domains in Settings" design, with dark mode

Follows `plans/Plan_26.md`.

## Context

A design mockup of the Client UI — "Domains moved into Settings" — is the
reference for this work. It is an exported artboard, so its markup and
runtime are throwaway; the design lives in its inline styles and its
stylesheet, and the values there are what an implementation replicates in
its own components. The ask is to move the Client UI onto that visual
language, and to add light/dark theming, which the mockup does not itself
specify (verified: it contains no `dark` class, no `prefers-color-scheme`
query, and no second palette of any kind).

Three findings shaped this plan more than anything else, and all three came
from reading the repo rather than assuming:

### 1. The tokens already match. This is not a re-theme.

`apps/client/app/globals.css:56-89` and the mockup's `:root` block are the
**same shadcn "neutral" OKLCH palette**, value for value — `--background:
oklch(1 0 0)`, `--foreground: oklch(0.145 0 0)`, `--primary: oklch(0.205 0
0)`, `--muted-foreground: oklch(0.556 0 0)`, `--border: oklch(0.922 0 0)`,
`--ring: oklch(0.708 0 0)`, the whole `--sidebar-*` set, and `--radius:
0.625rem`. Only three things differ:

- **`--accent`**, which the repo has as `oklch(0.97 0 0)` (stock shadcn) and
  the mockup inverts to `oklch(0.205 0 0)` — identical to `--primary`. The
  mockup's own CSS comments complain about this twice, noting `--accent` is
  unusable as a row-hover wash and reaching for `--muted` and
  `--sidebar-border` instead. **The inversion is a mistake in the mockup's
  preset, not a design intent.** Do not copy it; keep the repo's `--accent`,
  and use `--muted` for row hover exactly as the mockup's own markup does.
- **`--chart-1..5`.** The mockup ships a five-step blue ramp. The repo's are
  blue/amber with a comment (`globals.css:75-76`) saying why: human vs. bot
  must stay separable under common red-green deficiencies. **Keep the repo's.**
  The mockup's ramp is decorative; the repo's encodes an accessibility
  decision that a restyle has no business reversing.
- **`--font-sans`**, covered in §2 below.

So the visual gap is not colour. It is **layout and density**: a 240px
sidebar on a `--muted` backdrop with the content pane as a floating
`--card` island at `--radius-xl` with a soft shadow; 34px nav rows; 36px
buttons; 40px icon buttons; row cards instead of tables; 13.5px controls
and 12.5px metadata against the repo's current `text-sm`/`text-xs`.

### 2. Dark mode is already built and wired to nothing.

This is the single largest saving in the plan, and it is worth stating
plainly because it changes what "add dark/light mode support" means:

| Piece | State on disk |
|---|---|
| `@custom-variant dark (&:is(.dark *))` | Present — `globals.css:5` |
| Complete `.dark` token block | Present — `globals.css:92-124` |
| `next-themes@^0.4.6` | **Already a dependency** — `apps/client/package.json:19` |
| A `useTheme()` consumer | Present — `components/ui/sonner.tsx:3,8` |
| `dark:` utilities | Present, but **only** inside `components/ui/*` |
| `ThemeProvider` | **Absent.** `components/providers.tsx` wraps the redux `Provider` and nothing else |
| `suppressHydrationWarning` on `<html>` | **Absent** — `app/layout.tsx:13` |
| Anything that sets `.dark` | **Nothing, anywhere** |

`next-themes` arrived as a transitive requirement of shadcn's sonner block
and has sat unused since; `sonner.tsx`'s `useTheme()` silently falls back to
`"system"` with no provider above it. **No new dependency is needed.** The
work is three small edits (§3) plus a dark audit of app-level classes, which
were all written light-only — zero `dark:` occurrences outside `components/ui`.

### 3. The mockup is faithful to the data model in almost every respect.

Checked field by field against `apps/server/src/db/schema.ts:58-93` and
`packages/shared/src/links.ts`. The Create Link dialog's controls map onto
real columns: tags → `links.tags`, "Forward query params" → `forwardQuery`,
"Query Parameters" → `presetParams`, "Expiry date" → `expiresAt`, Rules →
the `rules` table, and Archives → `status`. Two exceptions:

- **"Make short link crawlable"** with a tooltip about `robots.txt` is the
  mockup's name for `links.listed`, which is an opt-in to the domain's
  `/llms.txt` catalogue (`docs/adr/0013`, `schema.ts:82-85`). Same switch,
  wrong label and wrong tooltip. **Use the real semantics**: "List in
  /llms.txt", explaining that listing publishes the slug, name and
  destination.
- **The three-field "Redirects" dialog**, which is the one genuine model gap
  and is now in scope — see Part D.

The mockup also shows a **"Link pages"** nav item with no handler attached —
a bare nav row with no click target, unlike every sibling. It corresponds to
no feature. **Omit it.** And its API-key role list has only three roles;
the real ladder has four
(`packages/shared/src/roles.ts:4` — `viewer, author, manager, admin`). **Keep
all four.**

## Decisions taken with the user

1. **The stack does not change.** Next.js 15 App Router, `output: "export"`,
   `trailingSlash: true`, `basePath` from `NEXT_PUBLIC_BASE_PATH`, Bun
   workspaces, the `@linq/client` package, RTK Query, Tailwind v4 CSS-first,
   Biome. Nothing in this plan touches build tooling. `docs/adr/0006` (the UI
   is a client, not a page) stands unchanged.
2. **Adopt the mockup's sidebar**: Short links · Analytics · Archives, with
   Settings pinned at the foot.
3. **Archives is one page with two tabs** (Links, Domains), replacing
   `/links/trash/` and `/domains/trash/`.
4. **Analytics is one page with three tabs** (Overview, Visits, Orphans) —
   the existing panels restyled, not rebuilt. Deliberately *not* the
   mockup's single fused analytics screen: that would be a ground-up rewrite
   of `stats-panel.tsx` and `visits-card.tsx` for no functional gain.
5. **Domains moves under Settings**, alongside API keys.
6. **Self-host DM Sans** 400/500/600, committed to the repo.
7. **Dark mode**: `defaultTheme="system"` plus a Light/Dark/System control in
   the sidebar footer.
8. **Add the two missing redirect fields to the backend** so all three of the
   mockup's redirect fields are real.
9. **Extract reusable components and hooks** for every pattern already
   duplicated 3+ times in the client, alongside what the restyle itself
   needs — see Part B3.

---

## Part A — Tokens, typography, theming

### A1. Typography: DM Sans via `next/font/local`

The mockup loads DM Sans from Google Fonts with an explicit 400/500/600 axis
and builds its whole type scale on those three weights being *real* faces
rather than browser faux-bold. `globals.css:51-55` says why the repo has no
webfont: the Client UI is a static export built inside the Docker image, so
`next/font/google` would make the build need network access. That constraint
is real and stays.

**Use `next/font/local`, not a `public/` directory with `@font-face`.** This
is the non-obvious part and the reason to write it down: there is no
`public/` dir in `apps/client` today, and if one were added, a `url()` inside
`globals.css` would **not** get the `/home` basePath prefix — Next rewrites
`next/link` hrefs and bundler-emitted asset URLs, not arbitrary strings in a
CSS file. The font would 404 in the bundled build and work only in the
standalone one. `next/font/local` emits hashed files under
`_next/static/media/` through the bundler, so the basePath is applied for
both build targets from one source.

- Commit `apps/client/app/fonts/DMSans-{Regular,Medium,SemiBold}.woff2` plus
  the upstream `OFL.txt`. Roughly 25-30 KB each, subset to latin.
- Declare in `app/layout.tsx` with `variable: "--font-sans"`, `display:
  "swap"`, and `fallback` carrying the current system stack verbatim so a
  failed load degrades to exactly today's rendering.
- **Delete the `--font-sans` declaration from `:root`** in `globals.css`
  (lines 51-55, keeping an amended comment) — `next/font` now owns that
  variable, and leaving both would make the winner depend on cascade order.
  `@theme inline`'s `--font-sans: var(--font-sans)` and `--font-heading`
  alias both keep working untouched.
- `--font-heading` is currently aliased to `--font-sans` and is a no-op hook
  (`globals.css:8`). It stays aliased — the mockup uses one family
  everywhere, and says so in a comment.

### A2. Token edits in `globals.css`

Small, because §1 established the palettes already agree.

- **Keep** `--accent`/`--accent-foreground` as they are (reasoning in §1).
- **Keep** `--chart-1..5` in both blocks (reasoning in §1).
- **Add** the mockup's weight scale as three tokens in `@theme inline`, so
  the 400/500/600 rule is one decision rather than a literal on every
  element: body 400, controls 500, titles 600.
- **Add** a `--shadow-panel` token for the floating content pane
  (`0 1px 2px rgb(0 0 0 / 0.04), 0 8px 24px -12px rgb(0 0 0 / 0.08)`), and
  redefine it under `.dark` — the mockup's shadows are tuned for a white
  pane on grey and vanish on a dark backdrop, where a `--border` hairline
  does the separating work instead.
- The derived radius scale (`globals.css:41-48`) already produces the
  mockup's `--radius-sm/md/lg/xl` closely enough; **do not touch `--radius`**.

### A3. Dark mode, three edits

1. `components/providers.tsx` — wrap in `next-themes`' `ThemeProvider` with
   `attribute="class"`, `defaultTheme="system"`, `enableSystem`, and
   `disableTransitionOnChange` (that last one matters here: the shell carries
   `transition-colors` on nav links, and without it every theme switch
   animates the whole sidebar).
2. `app/layout.tsx` — add `suppressHydrationWarning` to `<html>`. Required:
   `next-themes` sets the class before React hydrates, so the server-rendered
   HTML and the first client render differ by construction.
3. A `ThemeToggle` in the sidebar footer (Part B), three segments —
   Light / Dark / System — using `lucide-react`'s `Sun`, `Moon`, `Monitor`.
   It must render its active state only after mount, or the static export's
   prerendered HTML will claim a theme the visitor has not chosen.

`sonner.tsx` needs no change — it already reads `useTheme()` and will simply
start returning the real value.

**The dark audit is the actual work here, not the provider.** Every
app-level class was written light-only. The rule to apply while restyling:
reach for a semantic token (`bg-card`, `bg-muted`, `text-muted-foreground`,
`border-border`) and never a literal. Two literals already on disk need
fixing as they are touched:

- `border-color: #D0D0D0` on the mockup's favicon tiles → `border-border`.
- `.toggle-knob { background: #fff }` and `.btn-destructive { color: #fff }`
  in the mockup → `--background` and `--destructive-foreground`.

Note `--border` in `.dark` is `oklch(1 0 0 / 10%)` — an alpha token. It
reads correctly over `--card` but nearly disappears over the darker
`--background` backdrop, which is precisely where the mockup puts the
content pane's edge. This is what `--shadow-panel`'s dark redefinition (A2)
compensates for; check it on the Archives and Settings panels specifically.

---

## Part B — The app shell

`components/app-shell.tsx` is the centre of the change. Today: `flex
min-h-screen`, a `w-56 border-r bg-card` aside, and `<main class="min-w-0
flex-1 px-6 py-6">` (lines 146-198).

Target, from the mockup's root div and `<aside>`:

- Root `flex` on `bg-muted` — the grey backdrop.
- `<aside>` 240px, `p-4`, **transparent** (it sits on the backdrop; the
  current `bg-card` + `border-r` both go away).
- `<main>` padded `16px`, containing one `bg-card rounded-[--radius-xl]`
  panel carrying `--shadow-panel` and `overflow-hidden`, with an inner
  `max-w-[1080px] mx-auto` column. That floating island is the single most
  recognisable thing about the design.
- Wordmark: a 22px `--primary` rounded square holding a link glyph, then
  "Linq" at 15px/600 with `-0.02em` tracking.
- `ServerSwitcher` **moves from the footer to the top**, directly under the
  wordmark, as a bordered 44px row showing the active server name with a
  `chevrons-up-down` glyph. This is a real behavioural improvement, not just
  a move: the switcher is how you leave an unreachable server, and
  `AppShell` deliberately keeps the chrome mounted in exactly that case
  (`app-shell.tsx:114-126`), so putting it above the fold is the right call.
- Nav rows: 34px, `gap-10px`, `rounded-[--radius-lg]`, 13.5px/500, each with
  a 16px lucide icon. Active: `bg-sidebar-border` + weight 600 — **not**
  today's `bg-primary text-primary-foreground`, which the mockup explicitly
  rejects in a comment for being too loud.
- Footer: the identity row (`me.name · me.role`), the new `ThemeToggle`, and
  the Leave button.

### B1. The nav model

`NAV` and `SETTINGS` (lines 32-65) are rewritten. Group headings disappear —
the mockup's sidebar is flat, with Settings pinned below a spacer.

```
Short links   /links/      always
Analytics     /analytics/  always
Archives      /archives/   can.purge        ← was two Trash entries
────────────────────────── (flex-grow spacer)
Settings      /settings/   always           ← index page, see C3
```

Three things to preserve while rewriting:

- **`activeHref`'s longest-prefix rule** (lines 82-86) still earns its keep:
  `/links/` remains a prefix of `/links/detail/`. Keep the function as-is.
- **`visible` predicates are cosmetic.** The comment at lines 96-98 is
  correct and should survive: every call is re-checked server-side against
  the same `can.*`. Hiding a nav entry is courtesy, not a gate — page-level
  `requires` is what gates.
- **The mockup's per-item counts** ("Short links 128", "Archives 12") are
  easy and cheap: both are a `limit=1` query read for `total`, which
  `app/overview/page.tsx:17` already does three times. Reuse that pattern.

### B2. New `components/ui` primitives

`components/ui` has 16 shadcn primitives and is missing what the design
needs. Add via the shadcn CLI so they land in the configured `radix-nova`
style (`components.json:3`), rather than hand-writing them:

```bash
bun x shadcn@latest add tabs tooltip switch separator
```

- **`tabs`** — required by Archives (C2) and Analytics (C1). Not optional.
- **`tooltip`** — the mockup hangs a hover tooltip off every icon button via
  `aria-label` and a CSS `::after`. A real Radix tooltip is the better
  implementation: focus-visible triggers it, and the CSS version is
  invisible to keyboard users.
- **`switch`** — the mockup's `.toggle` for the Create Link dialog's
  Query Parameters / Expiry / Rules sections.
- **`separator`** — sidebar and dialog dividers.

`cn` is the npm package `cn@0.3.0` imported from the bare specifier `"cn"`,
**not** `@/lib/utils` (which is a vestigial one-line re-export that nothing
imports). `clsx` and `tailwind-merge` are not dependencies. Generated
components may need their import line corrected to match the existing
convention — check `components/ui/card.tsx:2` for the house style.

### B3. The reusable component layer

The restyle touches every page, so it is the right moment to extract the
patterns that are already copied around. This section is the plan's answer
to "make things reusable", and it is deliberately **evidence-led**: each
component below is justified by call sites that exist on disk today, not by
what might be useful later.

`components/common.tsx:34-37` already states the house rule, and it is a good
one — *"the pieces every page shares that shadcn has no primitive for, plus
thin wrappers over primitives that would otherwise be copied out ten
times."* This plan extends that rule rather than replacing it. A component
earns its place by having **two or more real call sites on the day it
lands**.

#### Where it lives

`common.tsx` is 420 lines and holds nine unrelated exports; adding eight more
would make it the file nobody wants to open. Split by role instead, with no
new workspace package — `packages/shared` is pure Zod with no React or JSX,
and a `@linq/ui` package would mean react peer deps, a JSX tsconfig and a
build step for exactly one consumer.

```
apps/client/components/
  ui/           stock shadcn, vendored — never hand-edited
  patterns/     NEW: composed, app-aware, reusable
    index.ts          one barrel, so call sites import from "@/components/patterns"
    page-header.tsx
    collection.tsx    QueryState + rows + empty, as one unit
    row-card.tsx
    short-link.tsx
    domain-picker.tsx
    stat-card.tsx     + the CardSkeleton that matches it
    icon-button.tsx
    empty-state.tsx
    tab-shell.tsx
  common.tsx    shrinks to the genuinely generic: DataTable, Pager,
                QueryState + skeletons, Field, Picker, ConfirmButton, CopyButton
  app-shell.tsx
```

The boundary that matters: **`ui/` knows nothing about linq**, `patterns/`
knows about domains, links and roles. Keeping that line means the shadcn CLI
can still regenerate `ui/` without clobbering hand-written work.

#### The components, and the duplication each one closes

| Component | Call sites today | Evidence |
|---|---|---|
| **`PageHeader`** | **11** | Every page hand-writes the same heading, in **5 different container shapes**. `font-heading text-xl font-semibold` appears verbatim at `domains/page.tsx:54`, `domains/trash/page.tsx:39`, `links/page.tsx:94`, `links/new/page.tsx:79`, `links/trash/page.tsx:46`, `links/detail/page.tsx:69`, `orphans/page.tsx:34`, `overview/page.tsx:29`, `visits/page.tsx:47` — while `settings/keys/page.tsx:62` (`font-medium text-lg`) and `page.tsx:91` (`text-lg`) both drift. The action slot is `ml-auto` twice and `justify-between` once; two pages have no wrapper at all, so adding a description later means restructuring. Takes `title`, optional `description`, and an `actions` slot. |
| **`Collection`** | **6** | Every list repeats `<QueryState …/>` immediately followed by the same guard — `{rows.length > 0 ? <DataTable head={HEAD}>…</DataTable> : null}` — at `links/page.tsx:166-173`, `domains/page.tsx:62-69`, `domains/trash/page.tsx:48-55`, `links/trash/page.tsx:54-61`, `settings/keys/page.tsx:68-75`, `visits-card.tsx:153-160`. One component takes the query result plus a row renderer and owns loading / error / empty / rows as a unit. **This is what makes the `DataTable`→`RowCard` switch a one-line change per page** rather than six hand-edits. |
| **`ShortLink`** | **6** | `{link.domainHost}/{link.slug}` is re-derived at `links/page.tsx:190`, `links/trash/page.tsx:73`, `detail:70`, and again inside three dialog titles (`trash:86`, `detail:190`, `detail:206`). Worth fixing rather than just deduping: the displayed string is scheme-less while the adjacent `CopyButton` copies the server-built `link.shortUrl` — **the text you read and the text you copy are different values.** One component renders the display form and pairs it with the copy action. |
| **`DomainPicker`** | **5** | The Radix empty-string sentinel is declared **five times** — `links/page.tsx:43`, `orphans/page.tsx:12`, `visits/page.tsx:11`, `visits-card.tsx:28` (`ANY`), `settings/keys/page.tsx:41` (`UNASSIGNED`) — each with its own copy of the explanatory comment, and three then repeat the identical round-trip (`value \|\| ANY_DOMAIN` in, `value === ANY_DOMAIN ? "" : value` out). It should also **own its own `useListDomainsQuery({ limit: 200 })`**, which is currently repeated at `links/page.tsx:62`, `visits/page.tsx:26`, `orphans/page.tsx:28` purely to feed the picker. Exposes `domainId: string`, `""` meaning all. |
| **`RowCard`** | **5** (new) | The mockup's `.link-row`. Replaces `DataTable` on Links, Archives (both tabs), Settings→Domains, Settings→Keys and the Servers list. Leading 40px tile slot, min-width-0 title/subtitle column, trailing actions slot. The single highest-leverage piece of the restyle. |
| **`IconButton`** | **~12** | The mockup's 40px square action button, wrapping the new Radix `Tooltip` so the label is announced rather than living in a CSS `::after`. Every row action across Links, Archives, Domains and Keys. |
| **`EmptyState`** | **6** | Today an `emptyMessage` string threaded through `QueryState` (`common.tsx:112`), and `rules-editor.tsx:124-128` hand-rolls a rival with `py-4` against `QueryState`'s `py-6`. Keep the string prop working and let `QueryState` render `EmptyState` internally, so no call site must change at once. |
| **`StatCard`** | **1 → 4** | `overview/page.tsx:44-64` has a local `Stat`; `CardSkeleton` (`common.tsx:90`) already exists as its loading twin but uses a **different box model** (raw `div` vs the real tile's `Card`/`CardContent`), so the skeleton and the thing it stands in for are different sizes. Analytics needs four. Extract both together and keep `tabular-nums` — it stops digits jittering as counts refresh. |
| **`TabShell`** | **2** | Archives (C2) and Analytics (C1) both need tabs whose active tab lives in `?tab=`. Wrapping it once means the URL-sync logic is written once. |
| **`RelativeTime`** | **5** | `When` (`common.tsx:176`) renders `toLocaleString()` — absolute. The design asks for "Created 4d ago" / "Archived 3d ago" at `links/page.tsx:218`, `keys:141`, `keys:144`, `detail:78`, `visits-card.tsx:167`. **Extend `When` with a `relative` prop** rather than adding a rival; keep the `<time dateTime>` element either way, since that is what keeps the exact value available on hover and to assistive tech. (Two call sites also wrap it in a redundant `text-muted-foreground` that `When` already sets — drop those.) |

#### Shared hooks — where the biggest win actually is

**The most-duplicated thing in the client is not markup.** It is this block,
which appears **13 times**:

```ts
try { await mutate(args).unwrap(); toast.success("…") }
catch (err) { toast.error(errorMessage(err, "That did not work.")) }
```

Seven copies also carry their own `saving` flag (`keys:107-116`, `keys:203-217`,
`keys:264-272`, `detail:138-160`, `rules-editor:79-90`, `links/new:55-75`,
`server-form:36-60`); six do not (`links/page.tsx:79-86`, `domains/page.tsx:44-50`,
`links/trash:35-41`, `domains/trash:28-34`, `detail:162-169`, `detail:172-180`).
The literal `"That did not work."` is spelled out in six of them.

`lib/use-api.ts` is the natural home for the hooks, and it is currently
**misnamed**: Plan 8 replaced `useApi` with RTK Query, but the filename
outlived the function and the file now holds only `useDebounced`
(`components/server-switcher.tsx:21` still has a comment referring to the
long-gone `useApi`). **Rename it `lib/hooks.ts`**, holding:

- **`useRun()`** → `{ run, saving }`. Wraps the block above: takes a thunk
  and an optional success message, owns the `saving` flag, and routes every
  failure through the existing `errorMessage` (`lib/api.ts:67`) into
  `toast.error`. `domains/page.tsx:44-50` already calls its local version
  `run()`, so the name is the repo's own. **13 call sites collapse to one
  implementation**, and the six-way-copied default message becomes a single
  constant. Highest-value item in this section.
- **`useDraft(initial)`** → `{ value, setValue, changed, reset }`. The
  "local draft, Save appears when it differs" pattern exists at
  `domains/page.tsx:110-111` and `settings/keys/page.tsx:101-105` and has
  **already diverged** — keys also rejects empty and disables its input
  while saving; domains treats empty as meaningful (`|| null` clears the
  fallback). Two further cousins model the same idea differently again:
  `detail:126-160` computes no dirty state at all and leaves Save
  permanently enabled, and `rules-editor.tsx:54-65` keeps an explicit
  `dirty` flag. Four places, three incompatible dirty strategies. A hook
  captures the comparison and leaves each call site its own markup and
  validation — which is precisely why this is not a component.
- **`useDebounced`** — moved as-is (`links/page.tsx:31`).
- **`useRange`** — moved from `common.tsx:350` unchanged, **comment
  included**: it documents a real RTK Query refetch-loop bug that a naive
  rewrite would reintroduce.

#### Two inconsistencies this refactor should fix, not preserve

Both surfaced while counting call sites, and both are behaviour rather than
style — worth deciding deliberately instead of carrying forward:

1. **Archiving a link is confirmed in one place and not the other.**
   `links/detail/page.tsx:189-196` wraps it in `ConfirmButton`;
   `links/page.tsx:228-241` archives on a single unguarded click. Same
   action, same consequence. Adopt the detail page's behaviour — a confirm
   — everywhere, via the shared row-actions cluster.
2. **`server-form.tsx:110-117` re-implements `QueryState`'s error markup**
   verbatim but for a `mb-3`. Use the shared one and pass the margin.

Related, and cheap while nearby: `LinearProgress` (`common.tsx:141`) is
private, yet `server-form.tsx` and `overview/page.tsx` both hand-roll
loading affordances. Export it.

#### What deliberately stays a one-off

Named so review knows they were considered, not missed:

- **`stats-panel.tsx`, `visits-card.tsx`, `rules-editor.tsx`,
  `preset-params-editor.tsx`, `tag-picker.tsx`** — already extracted, already
  reused. They get restyling and a dark pass, not restructuring.
- **The filter toolbars.** Five layouts across `links/page.tsx:102-162`,
  `orphans:40-58`, `visits:29-42`, `visits-card.tsx:112-149` and
  `stats-panel.tsx:112-123`, but they filter by different things (tags and
  status exist only on Links) and hold state differently — Links keeps a
  `filters` object, the others bare `useState`. `DomainPicker` takes the one
  genuinely identical piece; a `FilterBar` over the rest would need so many
  optional props it would read worse than the five toolbars it replaced.
- **"Reset `offset` on filter change"** — 7 sites and two mechanisms
  (`links/page.tsx:74-77` and friends vs. `visits-card.tsx:58-60`'s
  `scopeKey` + `useEffect`). Genuinely repetitive, but the fix is a
  `useFilters` state container that would rewrite how three pages manage
  query state — too much to carry inside a restyle. **Flagged as the
  obvious follow-up**, deliberately not attempted here.
- **A number formatter.** `tabular-nums` is applied by hand 6× with no
  `Intl.NumberFormat` anywhere, so counts render unformatted. Worth doing,
  but it changes displayed values and belongs in its own change.
- **`shortUrl` itself** — built server-side
  (`apps/server/src/http/api/links.ts:53,66`). Only its *display* form is
  duplicated, which `ShortLink` covers.
- **`DataTable` stays exported.** `/links/detail/` and anywhere columns
  genuinely help can keep it; it simply stops being the default.
- **The duplicated checkbox rows and three `Field` hint strings** shared by
  `links/new` and `links/detail` — already handled by C4, which merges both
  into one `link-form-dialog.tsx`.

#### The gallery route

`app/dev/components/page.tsx` renders every pattern above in each of its
states, with a light/dark switch at the top. It costs one page and no new
dependency, and it pays for itself twice: it is the fastest way to review
the component set, and it is **the surface for A3's dark audit** — every
component visible in dark at once, instead of hunting page by page.

Two honest notes. The App Router has no route-exclusion config, so the page
would otherwise ship to production; add `rm -rf out/dev` to `build` and
`rm -rf out-standalone/dev` to `build:standalone`, which matches how
`build:standalone` already post-processes its export directory. And because
it is pruned, it must **not** be added to `admin-static.test.ts`'s page list
— a test asserting it 200s would fail the bundled build. It uses fixture
data only, renders outside `AppShell`, and needs no server connection.

---

## Part C — Routes

Current 11 pages (`app/**/page.tsx`) become 9. Routes are basePath-free in
source; `next/link` prepends `/home`.

| Today | After | Note |
|---|---|---|
| `/` | `/` | Servers / connect. Restyled to the mockup's plain-page treatment — a bordered 480px card on `--background`, its own top bar with the wordmark, **no** app shell. Unchanged in function. |
| `/overview/`, `/visits/`, `/orphans/` | **`/analytics/`** | Three tabs. C1. |
| `/links/` | `/links/` | Row cards + create/edit dialogs. C4. |
| `/links/new/` | *removed* | C4. |
| `/links/detail/?id=` | `/links/detail/?id=` | Kept, restyled. Query-string id is load-bearing: a static export cannot prerender per-id paths. |
| `/links/trash/`, `/domains/trash/` | **`/archives/`** | Two tabs. C2. |
| `/domains/` | **`/settings/domains/`** | C3. |
| `/settings/keys/` | `/settings/keys/` | Restyled. |
| — | **`/settings/`** | New index; redirects to `/settings/keys/`. C3. |
| — | **`/dev/components/`** | Pattern gallery. Dev only — pruned from both production exports, so it is **not** added to `admin-static.test.ts`. B3. |

**`apps/server/test/admin-static.test.ts:36-46` hardcodes the exported page
list** and will fail until updated — it currently names `overview`, `links`,
`links/new`, `links/detail`, `links/trash`, `orphans`, `domains`,
`domains/trash`, `settings/keys`. Replace with the new set. (It also omits
`visits` today, which looks like an oversight; the replacement should be
complete.)

Since the whole route table moves, keep `/overview/`, `/visits/`,
`/orphans/`, `/domains/` and the two trash paths as **thin redirect pages**
that `router.replace` to the new location. Bookmarks and the `/home/...`
URLs in `README.md` otherwise 404 silently, and a static export gives no
server-side rewrite to lean on.

### C1. `/analytics/` — three tabs

One `AppShell`, `PageHeader` "Analytics", `Tabs` with Overview / Visits /
Orphans. Each tab's body is today's page content moved essentially verbatim:

- **Overview** — three stat tiles rebuilt as the mockup's `.stat-card`
  (`flex-1`, bordered, 12.5px muted label, 24px/600 value) + `StatsPanel`.
- **Visits** — `StatsPanel` + `VisitsCard` with the shared domain `Picker`.
- **Orphans** — domain filter, `StatsPanel` grouped by slug, `VisitsCard`.

`stats-panel.tsx` (recharts) and `visits-card.tsx` keep their logic; they
get card chrome matching `.chart-card` / `.stat-list-card` and a dark-mode
pass on the recharts axis/grid/tooltip colours, which are the most likely
place for a hardcoded light-mode value to survive. Drive them from
`--chart-1`/`--chart-2` and `--muted-foreground`.

Tab state goes in the URL (`?tab=visits`) so a tab is linkable and survives
reload. `/links/detail/` already establishes query-string state as the
pattern for this export.

### C2. `/archives/` — two tabs

`AppShell requires={can.purge}` — inherited unchanged from both trash pages,
which are already `can.purge`-gated (`links/trash/page.tsx:26`,
`domains/trash/page.tsx:19`), and the reason is in `docs/adr/0002`: archived
rows are kept forever and purge is the only removal.

- Header: "Archives", with the mockup's explanatory line and — on the Links
  tab — its outline-destructive "Empty archive" action.
- **Links tab**: `RowCard` per archived link — favicon tile, name, short
  path, destination, "Archived {ago}", with Restore and Delete-permanently
  icon buttons. Restore is `useUpdateLinkMutation({status:"active"})`;
  delete is `ConfirmButton` → purge.
- **Domains tab**: `RowCard` per archived domain — globe tile, host,
  fallback URL, link count. Purge keeps its **type-to-confirm**
  (`ConfirmButton confirmText={domain.host}`, `domains/trash/page.tsx:66-75`).
  Do not drop that: it guards an irreversible delete that takes the domain's
  visits with it.

The mockup's tooltips on this page use `.tooltip-down` because the actions
sit on the first row of a scrolling panel and an upward tooltip gets clipped.
Radix's collision detection handles this automatically — another reason B2
prefers the real primitive.

### C3. Settings, with Domains inside it

`/settings/` is new and redirects to `/settings/keys/`. The section gets a
**172px left sub-nav** (per the mockup) rather than tabs, because it is the
one place the design uses that pattern and it scales as settings grow.

- **`/settings/keys/`** — `requires={can.manageKeys}`. `RowCard` per key:
  key-glyph tile, name, role `Badge`, "This key" badge when `apiKey.id ===
  actor.keyId`, `prefix · Created {ago}` in mono, revoke icon button hidden
  for your own key. Mint dialog keeps its two-stage reveal-once flow, which
  is a security property, not a style. `ReassignLinksDialog` stays —
  `docs/adr/0011` makes it the middle step of key rotation.
- **`/settings/domains/`** — moved from `/domains/`. `RowCard` per domain:
  globe tile, host, redirect summary as subtext, "Edit redirects" and
  Archive actions. Everyone can read it; write controls stay gated on
  `can.manageDomains`, which is admin-only, exactly as today
  (`domains/page.tsx:40`).
  - The inline `NewDomainCard` becomes the mockup's **"Add domain" dialog**
    (440px, one host field, Enter to submit).
  - Fallback-URL-in-place editing becomes the **"Redirects — {host}"
    dialog** (480px, now three fields — Part D).
  - Archiving keeps `ConfirmButton`. Worth knowing while testing: since
    `plans/Plan_26.md`, a domain with *any* link — archived included —
    refuses to archive with a 409. That is correct behaviour, not a bug in
    the new UI. Surface the message through the existing `toast.error(
    errorMessage(err, …))` path.

A note on role visibility that the current nav gets right and the new one
must not lose: Domains is visible to every role while Keys is admin-only, so
the Settings sub-nav must filter per-item. Today `NavGroup` hides a whole
group when every child is invisible (`app-shell.tsx:211`); with Domains
always visible that can no longer happen, but the per-item filter still
matters — a viewer must not see a Keys entry that renders `NotPermitted`.

### C4. `/links/` and the create/edit dialog

The mockup makes Create Link a **dialog over the list**, with Edit reached
from a row's overflow menu. That is the one place this plan removes a route.

- Extract a shared **`components/link-form-dialog.tsx`** from
  `app/links/new/page.tsx` (182 lines) and the settings half of
  `app/links/detail/page.tsx` (319 lines). It already has every control the
  mockup draws — domain select, slug, destination, name, `TagPicker`,
  `PresetParamsEditor`, expiry, `listed` — plus `RulesEditor`, which the
  mockup also draws. Mostly a move, not a rewrite.
- `/links/` gains a "Create link" primary button; each `RowCard` gains a
  `DropdownMenu` with Edit / Duplicate / Archive. **`can.createLink` and
  `can.editLink` now gate the button and the menu items**, since the
  page-level `requires={can.createLink}` on `/links/new/` disappears with
  the route.
- **`/links/new/` is deleted**, with a redirect stub left behind (Part C).
- `/links/detail/` keeps per-link stats, `RulesEditor` and purge.

This step is separable. If it looks too large in review, `/links/new/` can
stay a page for one more round and the list can link to it — everything else
in this plan is unaffected.

---

## Part D — Backend: the two missing redirect fields

The only part of this plan that leaves `apps/client`. The mockup's
"Redirects" dialog shows three fields; `domains` has one, `fallbackUrl`
(`schema.ts:48`). Decision taken: **make all three real.**

The good news is that the redirect handler already distinguishes the three
cases — it just funnels them into one column. `apps/server/src/http/redirect.ts:200-208`:

```ts
if (!link) {
  const destination = domain.fallbackUrl
  if (tracked) recordVisit(c.var.db, { ...visit, linkId: null, destination })
  if (!destination) return c.text("Not Found", 404)
  …
}
```

Mapping the mockup's three fields onto branches that exist:

| Mockup field | Condition | New column |
|---|---|---|
| Base path redirect | `slug === ""` | `basePathRedirect` |
| Regular 404 redirect | slug non-empty, well-formed, no active link | `fallbackUrl` (**unchanged**) |
| Invalid short URL redirect | slug non-empty, fails `SLUG_PATTERN` | `invalidShortUrlRedirect` |

Four decisions inside that table:

1. **`fallbackUrl` is not renamed.** It already means exactly "regular 404
   redirect" and is the overwhelmingly common case. Renaming it would churn
   the schema, `ResolvedDomain`, the cache payload, `llms.ts`, the API
   contract and `plans/Plan_1.md`'s vocabulary for zero behavioural gain.
   The two new columns are additive and default `NULL`.
2. **"Malformed" is `SLUG_PATTERN`, not `slugSchema`.**
   `packages/shared/src/primitives.ts:27` — `/^[A-Za-z0-9_-]{1,64}$/`. Use
   the bare pattern: `slugSchema` additionally rejects `RESERVED_SLUGS`, but
   reserved first segments are already hard-404'd at `redirect.ts:167`,
   *before* the domain is even looked up, and that ordering is deliberate
   (its comment explains it keeps `/api/v1/typo` out of the orphan stream).
   Testing `slugSchema` here would reclassify a case the handler has already
   decided.
3. **Each new field falls back to `fallbackUrl` when null**, so existing
   domains behave identically after the migration and an operator who sets
   only the one field still gets sensible behaviour on all three paths. This
   is what makes the change non-breaking.
4. **Orphan recording is unchanged.** All three branches still
   `recordVisit(… linkId: null, destination)` with whichever destination
   won; only the value of `destination` can now differ. `recordVisit`
   needs no change.

Files, in order:

- **`apps/server/src/db/schema.ts`** — two nullable `text` columns on
  `domains`. Then `bun run db:generate` (per `AGENTS.md`; migrations apply at
  boot, there is no separate migrate command, and generated SQL is never
  hand-edited). Follow `.claude/skills/linq-db-migration`.
- **`packages/shared/src/domains.ts`** — add both to `domainCreateSchema`,
  `domainPatchSchema` and the `Domain` type, reusing `urlSchema.nullable()`.
  `PATCH` spreads the validated patch into `.set({ ...patch })`
  (`api/domains.ts:150`), so the handler needs no per-field wiring — but the
  comment at `api/domains.ts:154-155` saying "Both patchable fields" is now
  wrong and must be updated.
- **`apps/server/src/http/api/domains.ts`** — add both to `toDomain` (:25)
  and to the `POST` insert (:116).
- **`apps/server/src/http/redirect.ts`** — widen `ResolvedDomain` (:18) and
  `findActiveDomain`'s select (:54-59), then split the `if (!link)` branch
  three ways.

  **One caveat worth the line it takes.** `ResolvedDomain` is cached under
  `domainKey(host)` and JSON-round-tripped through Redis
  (`redirect.ts:170`). A Redis that survives the deploy will hand back
  entries written in the old two-field shape, so the new fields arrive
  `undefined`. Read them as `?? null` rather than trusting the type. Every
  domain mutation already does `cache.del(domainKey(...))`
  (`api/domains.ts:122,159,184,223`), so this is a deploy-window concern
  only, and a `?? null` closes it without a cache-key version bump.

- **`apps/client`** — the Redirects dialog gets its three fields with the
  mockup's help text under each, and `RowCard` subtext summarises which are
  set ("2 redirects" / "No redirects").

**Tests** (`apps/server/test/`, PGlite in-memory, no DATABASE_URL):
`domains.test.ts` for round-tripping both fields through POST/PATCH/GET, and
`redirect.test.ts` for the three branches — root path, unknown-but-valid
slug, malformed slug — plus the null-falls-back-to-`fallbackUrl` case and
the still-404 case when everything is null.

**An ADR is not needed.** Checked `docs/adr/` against
`.claude/skills/linq-adr`'s bar: this is additive, reversible, introduces no
dependency and crosses no security boundary. `0002` (archive, not delete) and
`0013` (`/llms.txt` opt-in) are untouched. If review disagrees, the argument
would be about orphan-visit semantics, and that belongs in this plan.

---

## Part E — Order of work

Each step should typecheck and lint clean before the next.

1. **A1-A3** — fonts, tokens, `ThemeProvider`, `suppressHydrationWarning`,
   `ThemeToggle`. Verifiable immediately against today's unchanged pages.
2. **B2** — the four new `ui` primitives from the shadcn CLI.
3. **B3, in four commits**, because it is the foundation everything after
   it builds on and it is the part most likely to be reviewed closely:
   1. **Hooks.** Rename `lib/use-api.ts` → `lib/hooks.ts`, move `useRange`
      across unchanged, add `useRun` and `useDraft`. Adopt `useRun` at all
      13 call sites. No visual change at all, and the largest single
      deletion in the plan — a good standalone commit.
   2. **Scaffold.** Create `components/patterns/` and its barrel.
   3. **Build against fixtures**, plus the `/dev/components/` gallery.
      Reviewable in isolation before any page depends on them.
   4. **Adopt the ones that pay off on the current design** — `PageHeader`
      across all 11 pages, `DomainPicker` across the five sentinel sites,
      `Collection` across the six list pages, `ShortLink` across its six.
      This lands the reuse win early and independently of the restyle, and
      fixes `settings/keys/page.tsx:62`'s odd heading and the
      display-vs-copy mismatch on the way past.

   `Collection` before the page work is deliberate: once every list renders
   through it, swapping `DataTable` for `RowCard` in steps 5-8 is one change
   per page instead of six hand-edits.
4. **B/B1** — the shell: backdrop, floating panel, sidebar, nav model.
   Point the new nav at the old routes for one commit so the app stays
   navigable.
5. **C3** — Settings with Domains and Keys. Delivers the title's ask.
6. **C2** — Archives.
7. **C1** — Analytics.
8. **C4** — Links list and the create/edit dialog.
9. **D** — the backend fields and the three-field dialog. Last on purpose:
   it is the only step with a migration, and keeping it off the critical
   path means a problem there blocks nothing else.

## Part F — Verification

Per `.claude/skills/linq-dev`; Postgres must be reachable at `DATABASE_URL`
or the server exits with `ERR_POSTGRES_CONNECTION_REFUSED`.

```bash
bun run dev           # API on :3000
bun run dev:client    # Client UI on :3001, basePath /home
bun run typecheck && bun run lint
bun run test          # apps/server/test and apps/client/test
```

The dev-environment skill's CORS note applies: the UI talks to the API
cross-origin even in development, by design (`docs/adr/0006`).

Manual passes, each in **both themes** and with the OS toggled mid-session
to confirm `system` tracks:

1. **Theme** — Light/Dark/System all apply; reload keeps the choice; no
   flash of the wrong theme on first paint (the `next-themes` script is what
   prevents it — confirm it survives the static export, this is the single
   most likely thing to regress).
2. **Components (B3)** — open `/dev/components/`, toggle the theme, and
   check every pattern in each state. Then confirm the adoption held:
   - every page heading is the same size, `Keys` included;
   - the domain filter behaves identically on Links, Visits and Orphans,
     and "All domains" still clears the filter rather than sending
     `__any__` to the API;
   - a failed write still toasts after the `useRun` collapse — break it
     deliberately (stop the API mid-session) and confirm each of the 13
     sites still reports, and that `saving` still disables its button;
   - archiving a link now asks for confirmation **from the list as well as
     the detail page**;
   - the short link you read matches the one the copy button puts on the
     clipboard.
3. **Shell** — floating panel reads correctly on both backdrops; the dark
   panel edge is visible (A2's `--shadow-panel`); sidebar counts are right;
   active nav row is right on `/links/detail/` (longest-prefix).
4. **Settings → Domains** — add, edit redirects, archive. Archiving a domain
   that has links must surface the 409 as a toast, not a silent failure.
5. **Settings → Keys** — mint (secret shown once, copy works), rename,
   change role, reassign links, revoke. Own key shows "This key" and no
   revoke control.
6. **Archives** — both tabs; restore a link; purge a domain via
   type-to-confirm.
7. **Analytics** — all three tabs; recharts legible in dark; `?tab=` is
   linkable.
8. **Links** — create and edit via dialog; row menu; archive; `/links/new/`
   and `/links/trash/` redirect rather than 404.
9. **Roles** — connect with a `viewer` key: no Keys entry in Settings, no
   create/edit controls, Domains readable. Then confirm the server refuses
   the same operations directly, since the UI's gating is cosmetic.
10. **Redirects (D)** — against a real domain: bare host → base path
    redirect; unknown valid slug → fallback; `a/b` or a 70-char slug →
    invalid redirect; each null → falls back to `fallbackUrl`; all null →
    404. Check the orphan visit is recorded with the destination that won.
11. **Both build targets** —

    ```bash
    bun run build:client              # /home, served by the server
    bun run build:client:standalone   # domain root
    ```

    Then confirm the **fonts load in the bundled build** — the basePath trap
    A1 exists to avoid. Check devtools Network for
    `/home/_next/static/media/DMSans-*.woff2` at 200, and that rendered text
    is real DM Sans rather than the system fallback.

## Out of scope

- The mockup's **"Link pages"** nav item — no such feature (§3).
- The mockup's **single fused analytics screen** — superseded by decision 4.
- **Mobile/responsive.** The mockup is a fixed 1440×900 artboard and
  specifies nothing below it; the app has no mobile treatment today. Not a
  regression, but it stays a gap.
- **`--accent` inversion** and the **blue `--chart` ramp** — rejected with
  reasons in §1.
- **`lib/utils.ts`**, the vestigial `cn` re-export nothing imports. Tempting
  to delete while nearby; it is unrelated cleanup.
- **A `useFilters` state container** for the 7 hand-rolled "reset `offset`
  on filter change" sites, and **a shared number formatter** for the 6
  hand-applied `tabular-nums` readouts. Both are real duplication, both are
  named in B3, and both would rewrite behaviour rather than appearance —
  the clearest follow-ups once this lands.
- **A bulk link purge scoped to a domain** — named as a likely follow-up in
  `plans/Plan_26.md` and still not built. The new Domains UI will make its
  absence more visible, since archiving a domain means purging every link
  first, one at a time.
