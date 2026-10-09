# 0006 – The Admin UI is a client, not a page linq serves

**Status**: accepted · 2026-09-16

## Context

The Admin UI began as something linq handed out. One process served the API at `/api`, the redirects at `/*`, and a static export at `/admin`; development faked the same arrangement with a Next rewrite that proxied `/api` to port 3000. Every request the UI made was same-origin by construction, so it needed no address and no configuration — it asked the origin that had just served it, and the origin answered.

That arrangement decides two things without ever saying so. It decides that the UI can only ever administer the one server it came from: to look at a second instance you open a second UI, and there is no way to move between them. And it decides that the UI cannot be deployed anywhere else, because the only thing that knows how to serve it is a linq server.

Both fell out of one assumption — that being served by a server tells the UI which server to talk to. Everything else followed: `basePath: "/admin"` baked into the build, a same-origin `/api` fallback for a record with no URL, and `/admin/` spelled by hand in every navigation that bypassed the router.

## Decision

**Nothing depends on being hosted by the server it administers.** Being served by a linq instance grants the UI no implicit address and no implicit credential.

A server is a record the user adds: a name, an absolute URL, and a Key, kept in that browser and verified against the live server before it is stored. The UI holds a list of them and talks to whichever is selected. There is no same-origin shortcut, and a record's URL is never empty — including the one written when a browser from before this change is migrated, which resolves the page's own origin to a concrete URL once and stores it like any other.

Two consequences follow.

**The API answers any origin.** `app.use("/api/*", cors())` on `/api/*`, wide open. A UI on another origin sends `Authorization`, which is never a simple header, so every call is preceded by a preflight that has to be answered or nothing works at all. Open is the honest setting for a self-hosted product whose operator chooses where to put the UI: an allowlist would be a list only that operator could write, defaulting to empty, and failing as an opaque `TypeError` with no way for the UI to explain itself.

What that costs is bounded. A key is still required on every call, no cookie is ever sent, and nothing is authorised by origin — so there is no ambient authority for another page to borrow. What CORS protects is a browser's implicit credentials, and this API has none. `/*` outside `/api` is unaffected: a redirect is a navigation, not a fetch.

**The UI has two build targets and one codebase.** `build` sets `NEXT_PUBLIC_BASE_PATH=/admin` for the export a linq server serves; `build:standalone` leaves it empty for a static host at a domain root. Both run identical code — the base path reaches the client through one constant, for the few `window.location` navigations Next does not rewrite, and nothing else in the app spells it.

## Consequences

A self-hoster who wants one process still gets one: the image is unchanged, and the server still serves `/admin`. A self-hoster who wants the UI on a CDN, or one UI for several instances, now has that — and someone administering three instances uses one deployment and switches.

The cost lands on first use. A fresh browser opening the UI at a server's own `/admin` is asked for that server's address, which it plainly already knows. That is the visible price of the rule above, and it is the honest one: a prefilled origin would be right in the bundled case and silently wrong in the standalone one, and a value the user cannot tell is a guess is worse than a field they fill once.

The backend keeps a UI-shaped hole it no longer needs. `mountAdmin` 404s when no export is present, so a backend-only deployment already works; that behaviour is now a supported shape rather than a degradation.

Keys live in `localStorage` in plain text, one per server. They did before this change too — there was one of them — but there are now several, and they arrive by being typed into a form rather than by an operator pasting into the one UI their server offered.
