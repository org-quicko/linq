# linq — Plan 20: capture OS/browser on visits; stop leaking the destination's link preview

Follows `plans/Plan_19.md`.

## Context

Two unrelated gaps, bundled into one plan because both live in the redirect
hot path (`apps/server/src/http/redirect.ts`) and touch the same handful of
files.

**1. No OS or browser on a visit.** `visits.platform` is a 3-way enum
(`android`/`ios`/`desktop`) computed by `detectPlatform()`
(`apps/server/src/visits/platform.ts`) — coarse by design, because it exists
to feed rule matching (`platform` is a `Condition` type in
`packages/shared/src/rules.ts`), not to describe the device. The raw
`user_agent` string is stored (`visits.userAgent`), but nothing parses it any
further: no OS (Windows/macOS/Linux/…) and no browser (Chrome/Firefox/…) are
ever extracted, stored, returned by the API, or shown in the Client UI. That's
the "not able to capture" gap — the data to derive it has been sitting in
`user_agent` the whole time, unused.

**2. Slack (and other chat/social apps) unfurl the destination, not the
short link.** `redirectHandler` issues the exact same instant `302` to every
caller — human or bot, browser or Slack's link-unfurl crawler
(`apps/server/src/http/redirect.ts:202`, `sendRedirect`). A chat app's preview
bot follows that redirect and reads Open Graph tags off the *destination*
page, so the card Slack renders shows the destination's image/title, not
anything belonging to the short link. `isbot` (already a dependency, driving
`detectBot()` in `apps/server/src/visits/bot.ts`) already recognises
Slackbot/Twitterbot/Discordbot/etc. as bots, but that flag currently only
affects the *recorded* `isBot` column — it has zero effect on what gets sent
back. The fix is to answer known link-preview crawlers with a small HTML
response carrying the short link's own Open Graph tags instead of a redirect,
while every other caller (including a human clicking the same link a second
later) keeps getting the instant 302 it gets today — no change to click-through
latency for anyone but the handful of preview bots.

## Part A — capture OS and browser

### A1. `apps/server/src/visits/platform.ts`

Add two more tiny detectors next to `detectPlatform`, same style — ordered
regex checks, most specific first, because a real UA packs multiple tokens
(an Edge UA also contains `Chrome` and `Safari`; Android's UA also contains
`Linux`; iOS's UA also contains `like Mac OS X`):

```ts
/** Nine checks, in order; anything unrecognised is null rather than a guess. */
export function detectOs(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null
  if (/Android/i.test(userAgent)) return "android"
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios"
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "macos"
  if (/Windows/i.test(userAgent)) return "windows"
  if (/CrOS/i.test(userAgent)) return "chromeos"
  if (/Linux/i.test(userAgent)) return "linux"
  return null
}

/** Edge/Opera/Samsung Internet all contain "Chrome" and "Safari" tokens too, so they're peeled off first. */
export function detectBrowser(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null
  if (/Edg\//i.test(userAgent)) return "edge"
  if (/OPR\/|Opera/i.test(userAgent)) return "opera"
  if (/SamsungBrowser/i.test(userAgent)) return "samsung-internet"
  if (/Firefox/i.test(userAgent)) return "firefox"
  if (/Chrome\//i.test(userAgent)) return "chrome"
  if (/Safari/i.test(userAgent)) return "safari"
  if (/MSIE|Trident/i.test(userAgent)) return "ie"
  return null
}
```

Free-form strings, not a pg enum: unlike `platform`, nothing matches rules
against these, so a new browser showing up in the wild never needs a
migration to become representable (mirrors `referer`/`destination`, already
plain `text`).

### A2. `apps/server/src/db/schema.ts`

Add two nullable columns to `visits` (near `platform`, line ~117):

```ts
os: text("os"),
browser: text("browser"),
```

### A3. New migration `apps/server/drizzle/0011_visit_os_browser.sql`

```sql
-- Captures what platform's three-way enum never could: the actual OS and
-- browser, parsed from the same user_agent already being stored. See
-- plans/Plan_20.md.
--
-- No backfill: existing rows keep null for both, same call 0010 made for its
-- own column change — only a future visit is affected. (Unlike a dropped
-- geolocation column, user_agent is still on every existing row, so a
-- backfill *is* possible later if the value of it ever justifies a full
-- table rewrite; it just isn't done here.)
ALTER TABLE "visits" ADD COLUMN "os" text;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "browser" text;
```

Run `bun run db:generate` after A2 to confirm drizzle-kit proposes exactly
this, then replace its generated SQL with the commented version above (same
two-part convention `0006`/`0010` used).

### A4. `apps/server/src/http/redirect.ts`

Import `detectOs, detectBrowser` and add both to the `visit` object literal
(line ~161):

```ts
const visit = {
  domainId: domain.id,
  slugRequested: slug,
  isBot: detectBot(userAgent),
  platform: detectPlatform(userAgent),
  os: detectOs(userAgent),
  browser: detectBrowser(userAgent),
  userAgent,
  referer: c.req.header("referer") ?? null,
  query: queryMap(url.searchParams),
}
```

Nothing else changes here — `recordVisit`'s `VisitInput` type is
`typeof visits.$inferInsert` minus `id`/`occurredAt`, so it picks up the two
new fields automatically once A2 lands.

### A5. `packages/shared/src/visits.ts`

Add to the `Visit` type (next to `platform`, line ~57):

```ts
os: string | null
browser: string | null
```

### A6. `apps/server/src/http/api/visits.ts`

Add to `toVisit()` (line ~17):

```ts
os: row.os,
browser: row.browser,
```

### A7. `apps/client/components/visits-card.tsx`

Replace the "Platform" column with "Device", showing OS + browser and falling
back to the coarse platform for rows that predate this change (or whose UA
matched neither detector):

- Head (line 65): `"Platform"` → `"Device"`.
- Cell (line 120):

```tsx
<TableCell>{[visit.os, visit.browser].filter(Boolean).join(" · ") || visit.platform}</TableCell>
```

### A8. `apps/server/test/redirect.test.ts`

Extend the existing table-driven test (line 319, `"records the platform each
user agent implies"`) with os/browser expectations per fixture UA already
defined at the top of the file:

- `ANDROID` (Linux; Android 14; … Chrome/120) → `os: "android"`, `browser: "chrome"`
- `IPHONE` (iPhone; … like Mac OS X) → `os: "ios"`, `browser` — the fixture
  string doesn't currently include a Safari/Chrome token, so either add one
  (`... AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile Safari/605.1.15`)
  or assert `browser: null` for it as-is; extending the fixture is the more
  useful test.
- `DESKTOP` (Macintosh; … Chrome/120) → `os: "macos"`, `browser: "chrome"`

### Deferred (not in this plan)

- **Stats/report parity.** `platform` is also a `GroupBy`/rollup dimension
  (`visitDimensionEnum`, the trigger functions in
  `0005_visit_rollup_triggers.sql`, `GROUP_BY` in `packages/shared/src/visits.ts`,
  `GROUP_LABELS` in `stats-panel.tsx`) so it can be charted as "80% Chrome,
  15% Firefox". Giving os/browser the same treatment needs new
  `visit_dimension` enum values, a trigger-function rewrite (same shape as
  `0006`'s `country`/`region` removal, in reverse), and two new stats charts.
  Real work, and not what "not able to capture" asked for — the raw log
  (A1–A7) already makes the data visible and queryable. Flag if you want the
  chart too and it becomes Plan 21.
- **Rule matching on OS/browser.** `platform` conditions exist because a rule
  might send Android users to a Play Store link; nothing here suggests rules
  need to branch on "Chrome vs Firefox" too. Not built.

## Part B — stop leaking the destination's preview to chat/social crawlers

### B1. `apps/server/src/visits/bot.ts`

Add a narrow, explicit detector — deliberately not "every bot `isbot` knows
about" (that would also catch monitoring/uptime bots and search crawlers that
*expect* a redirect and would misreport the link as broken if they got HTML
instead):

```ts
/**
 * Link-preview crawlers specifically — the ones that read Open Graph tags to
 * render a chat/social card. Distinct from `detectBot`: a monitoring bot or a
 * search crawler is a bot too, but it expects the real redirect, not a
 * preview page, so it is deliberately not included here.
 */
export function isPreviewCrawler(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false
  return /Slackbot|Twitterbot|facebookexternalhit|Facebot|Discordbot|LinkedInBot|TelegramBot|WhatsApp|SkypeUriPreview/i.test(
    userAgent,
  )
}
```

### B2. `apps/server/src/http/api/links.ts`

Export `shortUrl` (line 37) so `redirect.ts` can build the same canonical
`https://host/slug` URL instead of re-deriving the scheme rule a third time:

```ts
export function shortUrl(host: string, slug: string): string {
```

### B3. `apps/server/src/http/redirect.ts`

- Import `isPreviewCrawler` from `../visits/bot.ts` and `shortUrl` from
  `./api/links.ts`.
- `ResolvedTarget` (line 23) gains `name: string | null`, and
  `findActiveTarget` (line 73) returns `name: row.name` alongside the
  existing fields — no new query, `links` is already `select()`ed in full.
- Add the response builder, next to `sendRedirect`:

```ts
/**
 * What a link-preview crawler gets instead of the redirect: the short link's
 * own title, never the destination's. `link` is null on the orphan path,
 * where there's nothing to title it with but the domain itself.
 */
function ogPreview(c: Context<Env>, host: string, slug: string, link: { name: string | null } | null) {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
  const title = escape(link?.name ?? host)
  const url = escape(shortUrl(host, slug))
  c.header("cache-control", "no-store")
  return c.html(
    `<!doctype html><html><head><meta charset="utf-8">` +
      `<title>${title}</title>` +
      `<meta property="og:type" content="website">` +
      `<meta property="og:title" content="${title}">` +
      `<meta property="og:url" content="${url}">` +
      `</head><body></body></html>`,
  )
}
```

- Branch both existing `return sendRedirect(c, destination)` call sites
  (orphan path, line ~176, and the resolved-link path, line ~202) — nothing
  else in either path changes, so `recordVisit` still fires exactly as today,
  logging the same `destination` a real click would have gone to:

```ts
return isPreviewCrawler(userAgent) ? ogPreview(c, host, slug, null) : sendRedirect(c, destination)
```

```ts
return isPreviewCrawler(userAgent) ? ogPreview(c, host, slug, link) : sendRedirect(c, destination)
```

No `og:image`: there is no linq logo/asset anywhere in `apps/client` today,
and inventing one is a design task, not a bug fix. Most chat apps render a
card fine with no image; that beats guessing at a destination's image again.

### B4. `apps/server/test/redirect.test.ts`

New test near the existing bot-tracking one (line ~335):

```ts
test("a link-preview crawler gets the short link's own title, not the destination's", async () => {
  const link = await h.createLink(author.key, domain, { slug: "shared", name: "Q3 report" })
  const res = await get(`/${link.slug}`, {
    headers: { "user-agent": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" },
  })
  expect(res.status).toBe(200)
  const body = await res.text()
  expect(body).toContain("Q3 report")
  expect(body).not.toContain("example.com") // the fixture's destination host
})
```

### Deferred (not in this plan)

- **Per-link custom preview image/description.** This plan stops the
  destination's own OG tags from leaking through; it doesn't add a way to set
  a *branded* image/description per link. That's new schema
  (`links.ogImage`/`ogDescription`) and a Client UI field — a real feature,
  worth its own plan if wanted.
- **Mirroring the destination's real OG tags server-side** (fetch the
  destination once, cache its title/image, re-serve it under the short
  link's own URL) was considered and rejected here: it would need an
  outbound HTTP fetch on the redirect path (or a background job plus more
  cache-invalidation surface), and the user's actual complaint is that the
  destination's preview is what's currently showing — the fix is to stop
  that, not to get better at it.

## Sequencing

1. Part A (A1–A7), independent of Part B.
2. Part B (B1–B4), independent of Part A.
3. Either order is fine; nothing in one blocks the other.

## Verification

```
bun run db:generate   # after A2, to confirm the migration shape
bun test apps/server/test/redirect.test.ts
bun run test
bun run typecheck
```

Manual: open the Visits page after a few real requests from different
browsers and confirm the "Device" column shows something other than
`desktop`/`android`/`ios`. Paste a short link into Slack (or use
https://www.opengraph.xyz/ with a Slackbot user-agent override) and confirm
the card title is the link's name, not the destination page's title.

## Risks

- **Part A**: the regex lists cover the large majority of real traffic but
  are not exhaustive (no Vivaldi, Brave masquerades as Chrome by design,
  etc.) — same open-ended tradeoff `detectPlatform` already accepted for
  three buckets, now accepted for more. Unrecognised stays `null`, never a
  wrong guess.
- **Part A**: `ResolvedTarget`'s cache value shape is unaffected — os/browser
  are computed straight from the request's own User-Agent, never cached.
- **Part B**: `ResolvedTarget` gaining `name` *does* change the cached JSON
  shape under `targetKey`. Any entry cached before this deploy simply reads
  as `name: undefined` until its TTL expires or the link is next mutated —
  self-healing, same guarantee `docs/adr/0009` already relies on elsewhere.
- **Part B**: the crawler allow-list is an explicit, maintained set. A
  preview bot not on it keeps unfurling the destination exactly as today —
  no regression, just not-yet-covered. Extending the regex is a one-line
  change when the next one shows up.
