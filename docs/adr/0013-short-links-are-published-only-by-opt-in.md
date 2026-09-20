# 0013 – Short links are published only by opt-in

**Status**: accepted · 2026-09-20 · plans/Plan_25.md

## Context

A short link is already crawlable in the narrow sense that a crawler which
already knows the URL can follow it. But linq had no catalogue: nothing
enumerated what a domain publishes, so an LLM or a search crawler had no way
to discover a short link it was never told about directly. `/llms.txt` is the
convention that answers this — a plain-text index a crawler can fetch once and
read.

Confirmed by searching `.ts/.tsx/.md/.json/.sql` across the repo that no
`llms.txt`, sitemap or link-index code existed before this: the only
crawler-facing surfaces were `app.ts`'s one-line `robots.txt` and
`redirect.ts`'s `ogPreview`, and the latter serves social-preview crawlers
only (`isPreviewCrawler` deliberately excludes search crawlers).

`/llms.txt` cannot require an API key and still do its job — a crawler has
none — so whatever this route lists is enumerable by anyone who knows the
domain. That makes the default the whole decision. A short link's
*destination* is frequently the interesting secret: an unannounced campaign
page, a document behind SSO reachable only if you already have the link, a
partner-only landing page. Listing every active link by default would publish
all of that the moment this ships, to every domain already running linq, and a
crawl is not recoverable — the destinations are out, regardless of what
happens to the row afterwards.

## Decision

**Opt-in per link.** A new `links.listed` boolean, `not null default false`.
A link appears in its domain's `/llms.txt` only when its owner (or an editor)
explicitly switches it on — in the create form or in Settings, next to
`forwardQuery`.

**Rejected: opt-out.** List every active link, with a way to hide one.
Considered and rejected for the reason above: the default has to be safe on
day one, for every link that already exists, without anyone having to act.
Opt-out inverts that — silence publishes.

**Out of scope: `llms-full.txt`.** The full-content sibling convention (one
file per page's actual text) does not apply here. linq owns redirects, not
the content behind them; a link's "content" is its destination, which
`/llms.txt` already states.

## Consequences

- Every link created before this ships is unlisted by construction — the
  column's default is the same value a pre-existing row gets, so there is
  nothing to backfill and nothing was silently published by the migration.
- The security property this whole feature rests on is one line: a link
  created without `listed` does not appear. It has its own test in
  `llms.test.ts` and must never be the one deleted in a refactor.
- `/llms.txt` sits outside `/api/v1` and is never authenticated. That is not
  a gap to close — it is the entire point of the route — but it does mean
  `listed` is the only gate between a link and public enumeration, so no
  second surface should read `links` rows without going through it.
- A link's name and destination, once listed, are exactly as public as
  following the short URL once already made them. Listing does not expose
  anything a single click would not have; it only makes discovery possible
  without that click.
