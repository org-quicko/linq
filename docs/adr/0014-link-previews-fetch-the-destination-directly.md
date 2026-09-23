# 0014 – Link previews fetch the destination directly

**Status**: accepted · 2026-09-21.

## Context

An earlier design left the links list row with a generic glyph instead
of the destination's favicon, and flagged the alternative — `https://
www.google.com/s2/favicons?domain={host}` — as needing its own ADR before
adoption: it puts every destination hostname in a user's account on the wire
to a third party, from the browser, on every list render. That was never
decided; the glyph stayed.

Separately, a link's `name` is optional and blank by default — nothing fills
it in, so a freshly created link shows its slug and nothing else until
someone edits it by hand. `links` also has no field for a longer description
at all.

Both are the same problem: the destination itself already carries a title, a
description and an icon (`<title>`, `<meta name="description">`,
`<link rel="icon">`, and their Open Graph / Twitter Card equivalents), and
nothing today reads any of it.

## Decision

**linq fetches the destination's `<head>` itself, server-side, once, at the
point a link's destination is set** — on `POST /api/v1/links` and on
`PATCH /api/v1/links/:id` when `destination` is part of the patch — rather
than delegating to a third-party favicon or unfurl service.

This is the opposite trade-off from the third-party favicon alternative: no destination
hostname is ever disclosed to anyone but linq's own server, which already
knows every destination it stores. The cost is that linq's server now makes
an outbound HTTP request to a URL an authenticated key supplied, which is
server-side request forgery (SSRF) surface that did not exist before — the
redirect handler only ever sends a **browser** to a destination; it never
fetches one itself. `apps/server/src/link-metadata.ts` is written specifically
against that risk:

- **Private and reserved networks are refused**, not just at the URL a caller
  submitted but at **every hop of every redirect**, checked against the
  resolved IP (`node:dns/promises`), not the hostname string: loopback
  (`127.0.0.0/8`, `::1`), link-local including the `169.254.169.254` cloud
  metadata address, the RFC1918 ranges, `100.64.0.0/10`, and multicast —
  because a destination is free to redirect anywhere, and an internal service
  reachable only from linq's own network is exactly what this rule exists to
  keep off limits. Redirects are followed manually
  (`redirect: "manual"`, capped at 3 hops) specifically so each hop's target
  can be checked before it is ever connected to — Bun's default automatic
  redirect handling would connect first and offer no hook to refuse a hop.
- **An unresolvable hostname is refused, not retried or ignored** — the same
  fail-closed choice `LINQ_REDIS_URL` misconfiguration makes in
  `docs/adr/0009`: guessing "probably fine" about a host that cannot be
  looked up is how a check like this quietly stops doing anything.
- **The response is capped**: 1 MB read through a manual stream reader,
  cancelled past that, and only `text/html`-declared responses are parsed at
  all — a destination cannot make linq buffer an arbitrary amount of data by
  mislabeling a large file.
- **One request budget** (`AbortSignal.timeout`, 4 seconds) shared across every
  redirect hop, so a slow or hanging destination cannot stall a create or
  update indefinitely, only degrade it to "no preview data" once the budget
  is spent.
- **A fetch that fails, times out, or is refused is not an error** — the link
  is still created or updated exactly as requested, with `name`/`description`
  left as the caller sent them and `icon_url` left null. Nothing about this
  feature can turn a slow or hostile destination into a failed link creation.

**What this does not defend against**: DNS rebinding — a hostname resolving
to a public IP at check time and a private one at connect time, between the
lookup above and `fetch()` actually opening the socket. Closing that
requires pinning the connection to the address that was checked (a custom
`fetch` dispatcher/socket, which Bun does not currently expose a stable way
to do), not just re-checking sooner. Accepted for now because the caller who
would need to pull this off is already an authenticated `author`+ key with
standing write access to redirect traffic on a live domain — not an anonymous
caller — and the current check still closes the far larger surface: a
destination pointing at an internal hostname or IP outright, which is the
overwhelmingly common shape this kind of bug takes in practice. Revisit if
linq ever accepts links from a less trusted principal than an API key.

**Fetching itself can be switched off.** `LINQ_FETCH_LINK_METADATA` (default
`true`) disables the outbound fetch entirely when set to `false` — the same
opt-out shape `LINQ_CADDY_ADMIN_URL` and `LINQ_REDIS_URL` already give an
operator who does not want linq's server reaching out to arbitrary
caller-supplied hosts at all, for instance behind a network that blocks
egress to anything but an allowlist. Off, `name`/`description`/`icon_url`
behave exactly as if every fetch failed.

**No new dependency.** `apps/server/src/link-metadata.ts` parses HTML with
Bun's built-in `HTMLRewriter` (native, no package — see
`node_modules/bun-types/docs/guides/html-rewriter/extract-social-meta.mdx`
for Bun's own worked example of this exact pattern), not a DOM/HTML parsing
library.

**Precedence, when both are present**: `og:title` / `og:description` win over
`twitter:title` / `twitter:description`, which win over the plain `<title>`
element / `<meta name="description">` — Open Graph tags are the ones a page
author curated specifically for being shared elsewhere, which is exactly
what this feature is doing. The favicon prefers an explicit
`<link rel="icon">` (`rel~="icon"` also catches `rel="shortcut icon"`) over
`<link rel="apple-touch-icon">`, and falls back to guessing `/favicon.ico` at
the resolved origin when neither tag is present — unverified, since the
client's row tile already degrades a broken image to the existing glyph
(`onError`), so a second round-trip just to confirm the guess buys nothing.

## Consequences

**2026-09-23 security amendment.** Metadata fetching now defaults to `false`.
An operator must set `LINQ_FETCH_LINK_METADATA=true` to enable it. This
supersedes the earlier default stated above; the DNS-rebinding limitation and
the recommendation to constrain egress remain unchanged.

- A link's `name`, `description` and `icon_url` can now be populated without
  the caller supplying them, on both create and destination-changing
  updates. An explicitly supplied `name`/`description` — including an
  explicit `null` sent to clear one — always wins; the fetch only ever fills
  a field the request left out. `icon_url` has no caller-supplied form and is
  always whatever the fetch found (or last found, on an update that didn't
  touch `destination`).
- Create and destination-changing updates now have a network call on their
  critical path, bounded to 4 seconds by the shared timeout. This was chosen
  over doing the fetch in the background after responding, because a
  background job needs its own staleness/race handling (a second edit
  landing before the fetch completes) for a case — someone editing the same
  link again within seconds of creating it — narrow enough not to be worth
  that machinery. If link creation latency becomes a real complaint, moving
  this off the request path is the escape hatch, not rewriting it.
- Whether a fetch happened is testable without a real network: `link-metadata.ts`
  exposes the fetcher as a small seam (`MetadataFetcher`, one method), the
  same shape `Cache` and `Caddy` already are in this codebase, with a
  `noMetadata` no-op the test harness wires in by default — see `docs/adr/0009`
  and `docs/adr/0012` for the precedent this follows.
- This is unrelated to `docs/adr/0013` (opt-in publishing to `/llms.txt`):
  that ADR is about linq disclosing a link's *own* data to the public;
  this one is about linq's server reading a *destination's* public page,
  the same way any browser that ever opened that link already would.
