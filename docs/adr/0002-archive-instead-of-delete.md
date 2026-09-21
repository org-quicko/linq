# 0002 – Archive instead of delete; Slugs are reserved forever

**Status**: accepted · 2026-09-15

## Context

Short links live in the wild long after their owner forgets them. Hard-deleting a Link frees its Slug for someone else to claim, which lets a dead link be hijacked, and it destroys the Click history that analytics depend on. Domains have the same problem one level up.

## Decision

Links and Domains carry `status ∈ {active, archived}`. `DELETE` on the API sets `archived`. An archived Link stops redirecting (requests become Orphan Clicks) but keeps its row, its Clicks and its Slug, which can never be reused on that Domain. A Domain can be archived only when it has no active Links. Archived → active is allowed. There is no hard-delete endpoint.

## Consequences

- No link hijacking through slug reuse; analytics history is never lost.
- The slug namespace on a Domain is consumed permanently; random slugs (62^6) make this irrelevant in practice, custom slugs may need a new spelling.
- There is no way to purge data through the API. If regulatory or storage needs demand it, add an admin-only purge as a separate, explicit operation rather than changing `DELETE`.

## Amendment · 2026-09-15 — Purge

The purge foreseen above now exists, as a separate operation and not a change to `DELETE`. The decision above stands unchanged for every role but admin.

`DELETE /api/v1/links/:id/purge` and `DELETE /api/v1/domains/:id/purge` destroy an already-archived row. Admin only, and refused unless the resource is archived, so a live short URL can never be destroyed by one call: archiving and purging are always two deliberate steps. A Domain is refused while **any** Link row still points at it, archived ones included — a stricter bar than archiving, which only counts active ones.

What this trades away:

- **Purging a Link releases its Slug**, which anyone may then claim on that Domain. That is the anti-hijacking guarantee above, given up knowingly and only by an admin acting on an already-archived link. Archiving still never releases a Slug.
- Purging a Link keeps its Clicks, which become Orphan Clicks (`clicks.link_id` is `ON DELETE set null` for this reason) — history survives, attribution does not.
- Purging a Domain destroys its Clicks with it, because a Click cannot exist without a Domain. This is the one operation in link that loses analytics history.

Purge is irreversible and leaves no audit trail beyond the request log line, which records the acting user, the route and the status. The typed confirmation in the Admin UI is a speed bump in the browser, never a permission.

## Amendment · 2026-09-20 — Archive raised to match Purge (`plans/Plan_26.md`)

The Decision above and the Amendment before this one both said a Domain may be **archived** while any of its Links are archived — only an **active** Link blocked archiving; a stricter bar applied only to purging. That asymmetry is removed: **archiving a Domain now refuses while any Link row points at it, archived included — the same bar purging already used.**

The reason: an archived Link still owns its slug on that Domain, and an archived Domain cannot serve it. A Domain archived under the old rule while it still held archived Links was a dead end the old rule allowed to be created silently — a slug reserved forever on a host that can never resolve it again. There is no operation that undoes that shape once it exists, since slugs are never released except by purge (above), and a Domain cannot be purged while archived.

The cost, accepted knowingly: retiring a host that ever carried Links now means purging every one of them first, and there is no bulk purge — for a Domain with hundreds of Links, that is hundreds of admin purges through today's API. A domain-scoped bulk Link purge is the obvious follow-up if this bites, and is deliberately not built here.

`Domain.linkCount` in the API changes meaning with it: it now counts every Link, archived included, rather than active ones only. Same field, same type, a different number — any consumer reading it as "live links on this host" is silently wrong after this change.

## Amendment · 2026-09-21 — QR codes are deleted, not archived (`plans/Plan_31.md`)

QR codes are deleted, not archived, and have no purge. The decision above protects two things a QR code does not have: a reserved slug, and a visit history. Deleting one removes a saved appearance; it cannot hijack anything, and it loses no analytics — a scan is an ordinary visit on the link. `qr_codes.link_id` is `ON DELETE CASCADE` for the same reason. What a delete does *not* do is invalidate a printed code: the link is what resolves it, so archiving the link is still the only way to take one down.
