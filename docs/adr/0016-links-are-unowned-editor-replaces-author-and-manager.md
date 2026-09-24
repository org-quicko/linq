# 0016 – Links are unowned; `editor` replaces `author` and `manager`

**Status**: accepted · 2026-09-23

## Context

ADR 0011 made the API key the principal and gave every link an `owner_id`
pointing at the key that created it, with a four-role ladder built around
that ownership: `viewer < author < manager < admin`, where `author` could
only act on links its own key owned and `manager` could act on any link.

That distinction turned out to buy nothing. Nothing in linq groups keys into
teams or accounts, so "the key that happens to have clicked Create" is not a
meaningful boundary — it only ever produced friction: a `manager` role that
exists solely to bypass it, a `leftJoin` and an `owner_name` column on every
link read, a `links_owner_id_idx` index, a per-link transfer
(`PATCH /links/:id` with `owner_id`), a bulk-transfer endpoint
(`POST /keys/:id/links/reassign`) to migrate a key's links before demoting
it, and a refusal in `PATCH /keys/:id` that blocks a demotion while the key
still owns links (0011's amendments of 2026-09-20). None of it changes what
a link does; all of it exists to make the ownership boundary survivable to
work around.

Separately, "archive" (the soft-delete `DELETE /v1/links/:id` that ADR 0002
defines) was gated the same way as every other edit — `author` on its own
links, `manager` on any — with no distinction from renaming a link or
changing its destination. There was no admin-only step between "editing" and
"gone from the active list."

## Decision

**Roles collapse to three**: `viewer < editor < admin`. Both `author` and
`manager` become `editor`; an editor may create and edit (`PATCH`) any link,
not only ones its own key happens to have created.

**Archiving and restoring a link require `admin`.** `DELETE /v1/links/:id`
and a `PATCH` that changes `status` are no longer covered by the same
`editLink` check as every other field — a new `can.archiveLink` predicate
gates both directions of that transition. Purging (the irreversible hard
delete, already admin-only per ADR 0002) is unchanged.

**`links.owner_id` is dropped** — column, foreign key, and index — along
with the `owner_name` join on every link read and the `link_owner_id` field
QR codes carried for the same reason. A link is no longer stamped with the
key that created it.

**Transfer is gone, not reassigned.** `PATCH /links/:id` no longer accepts
`owner_id`, and `POST /keys/:id/links/reassign` is deleted outright — there
is nothing left to hand over. `PATCH /keys/:id`'s refusal to demote a key
below the ownership threshold while it owns links (0011, amendment of
2026-09-20) is removed with it: nothing points at a key any more, so
demoting one strands nothing.

## Consequences

- **Which key created a given link is no longer recoverable.** The
  migration that drops `owner_id` discards that history for every existing
  link, the same one-way stance ADR 0011's own migration (`0009`) took with
  key ownership at the time.
- **`can.editLink` and `can.createLink` take no resource argument any
  more** — permission is a pure function of the actor's role, never of what
  a link happens to be stamped with. `can.ownLink` and `can.transferLink`
  are deleted rather than left unused.
- The Client UI loses the link form's "Owner" field, the keys page's
  "Reassign links" dialog, and the owner column everywhere a link or QR code
  rendered one.
- An editor that could previously archive its own link now cannot — archiving
  is strictly narrower after this change, not merely reshuffled. Restoring an
  archived link (`PATCH` with `status: "active"`) was already reachable only
  from the Archives page, which has required `admin` since it shipped; this
  ADR is what makes the server agree.
- **This does not revisit ADR 0011's core claim** — the key is still the only
  principal, and authentication is still one indexed lookup. It only removes
  the ownership relationship a key used to have with the links it created.
