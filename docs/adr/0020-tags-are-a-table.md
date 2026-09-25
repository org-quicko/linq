# 0020 – Tags are a table

**Status**: accepted · 2026-09-25

Supersedes the "no tag table to keep in step" note that sat on `GET /v1/tags`.

## Context

Tags were a `text[]` column on `links` with a GIN index. That kept writes
trivial and made the list filter (`tags && $1`) index-backed, but:

- `GET /v1/tags`, which fills the tag picker, ran `unnest(tags)` over every
  active link on every call. A GIN index answers "which rows contain X", not
  "list every X", so nothing could make that query cheaper than a full scan.
- A tag had no identity of its own. Renaming one, giving it a colour or a
  description, or listing a tag before any link carries it would each need
  every array rewritten, or a table anyway.

## Decision

Two tables, created and backfilled by migration `0003_tag_table`, which then
drops `links.tags` and `links_tags_idx` in the same release:

- `tags (id, name UNIQUE, created_at)`
- `link_tags (link_id → links ON DELETE CASCADE, tag_id → tags)`, primary key
  `(link_id, tag_id)`, plus an index on `tag_id`.

The HTTP contract keeps its shape. A link still reads and writes
`tags: string[]`; `?tags=a,b` still matches a link carrying *any* of them;
`GET /v1/tags` still returns `[{ tag, count }]` over active links, most used
first. A link's tags come back sorted by name rather than in the order sent:
a tag set has no meaningful order, and storing one would be a column kept
only to echo input back.

Counts are still computed per request, not stored: a counter would need
adjusting on every create, tag edit, archive, restore and purge, and the one
that gets missed is silently wrong. Unlike ADR 0007's visit rollups, there is
no hot path here that justifies that risk.

## Consequences

- **Duplicates collapse.** The array accepted `["a", "a"]` and returned it
  twice; the primary key cannot. Writes and the backfill both keep one.
- **Order is alphabetical.** `["q3", "launch"]` reads back as
  `["launch", "q3"]`. Together with duplicates collapsing, these are the
  observable changes.
- **No rollback past `0003`.** There are no down migrations, and the column is
  gone, so a server build from before this change cannot start against a
  migrated database. Restoring means restoring a backup.
- Tags no link carries any more stay in `tags`. They never appear in
  `GET /v1/tags` (which counts through `link_tags`), so they are harmless
  until tags gain properties worth cleaning up.
- Backfilled tag ids are UUIDv4 (`gen_random_uuid`); new ones are UUIDv7.
  Nothing orders tags by id.
- Anything outside the app that read `links.tags` directly — ad-hoc SQL,
  reporting — must join `link_tags` and `tags` instead.
