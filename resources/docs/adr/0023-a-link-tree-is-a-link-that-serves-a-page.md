# 0023 – A Link Tree is a Link that serves a page

**Status**: accepted · 2026-11-27.

## Context

People wanted one short link for a profile page that lists their other links,
in the style of social-media link-in-bio pages. Until now the redirect host only
ever answered with a 302, an OG preview for crawlers, or a 404. A Link Tree page
has to live on a shortening Domain, at a Slug, with the same reservation,
archive and purge rules as any short link, and its views have to show up in
Analytics like any other Visit.

The obvious alternatives were a separate `trees` resource with its own slug
space, or Items as free-form URLs stored on the tree.

## Decision

A Link Tree is a row in `links` with `type = 'tree'`. The `link_type` enum
(`redirect`, `tree`) is new; `destination` became nullable, and the
`links_destination_by_type` check keeps it set for exactly the redirect Links.
The page's title and description are the Link's own `name` and `description`.
Only its look (`image_url`, `appearance`, `accent`, `button_style`) lives in
`link_trees`, keyed by `link_id`.

Items live in `link_tree_items`: an ordered label plus a target `link_id`, which
must be an active redirect Link on the tree's own Domain. A Link Tree can never
be an Item's target. An Item given as a URL becomes a normal short Link, created
in the same transaction as the tree, so it appears in Short links and has its
own analytics.

The redirect handler serves a tree's page itself. `ResolvedTarget` carries the
whole page (`type` and `tree`), so a cache hit renders it with no query, just
as rules ride inside a redirect's entry. Item URLs are root-relative (`/slug`),
because an Item always shares the tree's host. Each cached Item keeps its target's
expiry, and the handler drops lapsed Items at render time, because no mutation
arrives to clear the entry when an expiry passes. Any write to a Link (edit,
archive, restore, purge) also clears the cached page of every tree that lists it.

The page is one self-contained document from `LinkTreeUtil.renderPage` in
`@linq/shared`, with no script, no external stylesheet and no font request. It is
served under `default-src 'none'` with only inline style and images allowed. The
Client UI renders the same function into a sandboxed iframe for its preview,
so the preview cannot drift from the live page.

A page view is a Visit on the tree's Link, with no Destination. Clicks on Items
are Visits on the Items' own Links. Analytics filters a tree exactly as it
filters any Link, by `link_id`.

## Consequences

Everything a Link already has comes for free: the Slug rules, archive before
purge (ADR 0002), unowned Links and the `can.*` permissions (ADRs 0016, 0017),
tags, QR codes and the Analytics link filter. `GET /links` and `/links/count`
take `type`, defaulting to `redirect` so callers from before Link Trees see what
they always saw. Archives asks for `type=all`.

Analytics counts a tree's page views only. It does not credit an Item click to
the tree it came from. That would need a new attribution column on `visits` and
a change to the rollup (ADR 0007), so it was left out on purpose. An Item click
carries the tree's host as its referer, which is the only trace of the path.

The hot path now returns HTML for one Link type, and a tree's cached entry grows
with its Items. `LINK_TREE_MAX_ITEMS` (50) bounds that. A redirect-only field
(`destination`, `rules`, `forward_query_params`, `preset_params`) sent to a tree
through `/links` is a 400 rather than silently stored. Trees are never listed in
`/llms.txt` (ADR 0013), since they have no Destination to describe.
