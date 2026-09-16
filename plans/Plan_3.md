# link — Plan 3: keyless geolocation, and an admin purge

Follows `plans/Plan_2.md`, which is implemented.

> Work that follows this plan continues in [`Plan_4.md`](./Plan_4.md): the geo
> database as an external cache.

> **Status: implemented.** Both halves are done; 201 server tests pass, `tsc -b`
> and `biome check` are clean, and the Admin UI exports all its pages. Where the
> build differed from the plan below:
>
> - **The DB-IP record shape was verified first**, against the real September
>   file, as the Risks section demanded: `DBIP-Country-Lite`, MMDB 2.0,
>   `country.iso_code` populated, no `subdivisions` at all, 4.1 MB gzipped and
>   8.3 MB on disk. The reader change was made only after that.
> - **`ConfirmButton` gained a `confirmText` prop** rather than a second stricter
>   variant beside it: the dialog is otherwise identical, so one optional input
>   and one disabled rule was the whole change.
> - **The attribution lives in `common.tsx` as `GeoAttribution`**, not inline in
>   the stats panel, because the clicks table needs the same line.
> - **`LINQ_GEO_ENABLED` was kept** (it was flagged as unrequested). The test
>   config sets it false, so no suite ever reaches the network.

## Context

Two independent changes, both removing friction the current design bakes in.

**Geolocation.** Clicks carry a coarse country and region, derived in-request
from the client IP and never stored (ADR 0001). The source is MaxMind GeoLite2,
which needs an account, an accepted EULA and a licence key before it will serve a
download. For a self-hosted product that is a wall: an operator who will not sign
up gets `noGeo`, so every click has null country and region and **every `country`
rule silently fails closed** (`apps/server/src/rules/match.ts:21-22`). The goal is
the same data with no account, no key, working out of the box.

**Deletion.** `DELETE` archives rather than deletes (ADR 0002), keeping click
history and permanently reserving the slug so a dead link can never be hijacked.
That stays the default — but there is currently no way to purge anything at all.
ADR 0002 wrote its own escape hatch for exactly this:

> "There is no way to purge data through the API. If regulatory or storage needs
> demand it, add an admin-only purge as a separate, explicit operation rather
> than changing `DELETE`."

So this is not a reversal of ADR 0002. It is the operation the ADR told us to
add, and 0002 gets an amendment rather than a replacement.

---

## 1. Keyless geolocation — DB-IP Lite

### The source

`https://download.db-ip.com/free/dbip-country-lite-YYYY-MM.mmdb.gz` — verified
live, unauthenticated: no token, no cookie, no signup. 3.9 MB gzipped, 8 MB on
disk, republished monthly. Licensed **CC BY 4.0**, which permits commercial use
and redistribution and, unlike GeoLite2's CC BY-SA, does not touch our own
licensing.

Everything else was disqualified: IP2Location LITE needs an account *and*
forbids redistribution; ipinfo.io Lite needs a token and is country-only; CDN
country headers cannot be the sole mechanism, because an operator whose origin is
reachable directly receives attacker-controlled headers, and we do not control
operators' deployments.

**Country only for now.** Region lives in `dbip-city-lite`, 121 MB uncompressed —
fifteen times larger, for a field whose downstream use is not yet established.
The acquisition code is identical for both, so adopting region later is a
filename change.

### Why `lookup` barely changes

DB-IP Lite is MMDB 2.0 and populates `country.iso_code`, the exact field
`apps/server/src/clicks/geo.ts:63-66` already reads. Keep the `maxmind` package,
keep `Reader`, keep the `Geo` / `Location` / `noGeo` signatures. `redirect.ts:122`,
the rule engine and the `HarnessOptions.geo` stub in the test harness are all
untouched.

`region` becomes permanently null for new clicks. Leave the column, the
`Location.region` field and the `region` stats grouping in place: old rows keep
their MaxMind spellings, new rows group under "(not recorded)" via the existing
`coalesce(…, '')` in `stats.ts:35`, and moving to the city file later re-enables
it with no schema work.

### What gets deleted

| What | Where |
|---|---|
| `LINQ_MAXMIND_LICENSE_KEY` | `config.ts:13`, `.env.example`, `Dockerfile`, `docker-compose.example.yml`, `test/helpers/db.ts` |
| `extractMmdb` and its hand-rolled tar reader | `geo.ts:105-129`, plus the tar builder and three tests at `clicks.test.ts:86-131` |
| The MaxMind entry in the log scrubber | `log.ts:63-80`, and the "geo regression" test at `log.test.ts:235-247` |

DB-IP ships a plain `.mmdb.gz`, so `Bun.gunzipSync` alone is the whole unpack
step — roughly 60 lines of tar handling go away. The DB-IP URL carries no
credential, so that entire leak class disappears rather than being re-guarded.

### What gets added

- **Month-boundary fallback.** There is no `latest` alias; next month's file 404s
  until it is published, around 06:27 UTC on the 1st. Try the current UTC month,
  fall back to the previous on a non-200. Two lines, not a scheduler.
- **`LINQ_GEO_ENABLED`, default `true`.** Geo now does a third-party fetch at boot
  for every operator by default, and one with restricted egress deserves an
  explicit off switch rather than relying on the failure path. Not requested —
  drop it if unwanted.
- **Attribution**, required by CC BY 4.0. A small "IP Geolocation by DB-IP" link
  under the charts in `apps/admin/components/stats-panel.tsx` and under the clicks
  table in `apps/admin/app/links/detail/page.tsx` — the pages that display
  results, which is what the licence asks for — plus a `NOTICE` file carrying the
  attribution and licence URI.

### Accuracy, stated plainly

DB-IP Lite country agrees with GeoLite2 on **94.49%** of IPv4 space (sapics
ip-location-db, measured June 2026 — the only methodologically transparent figure
in this space; the rest is vendor self-reporting). About one address in eighteen
gets a different country.

That is not cosmetic: `country` conditions choose destinations, so a small share
of visitors will route differently after the swap. Nothing fails; behaviour
differs. This belongs in the ADR, not a code comment.

### ADR

New `docs/adr/0004-keyless-geolocation-database.md`. It clears all three bars:
hard to reverse once click history is built on it, surprising without context
("why not MaxMind?"), and a real trade — measurable accuracy given up for no
account, no licence key, and a licence that permits redistribution.

---

## 2. Admin purge

### Model

No new status. `RESOURCE_STATUSES` stays `["active", "archived"]` —
**archived is the soft delete**. Purge is a separate operation that destroys an
already-archived row.

- `DELETE /api/v1/links/:id/purge` — admin only. 404 unknown, **409 unless
  already archived**, 204 on success.
- `DELETE /api/v1/domains/:id/purge` — admin only. 404 unknown, 409 unless
  archived, 409 while any link row exists on it (**any status**, not just
  active), 204 on success.

Archive then purge, always two deliberate steps, so a live short URL can never be
destroyed by one call. The extra path segment means neither route can be shadowed
by the existing `DELETE /:id`.

| | Link purge | Domain purge |
|---|---|---|
| Slug | **released**, reusable on that domain | n/a |
| Rules | cascade away (`rules.linkId` is already `cascade`) | n/a |
| Clicks | **survive as orphans** | **destroyed** with the domain |
| Blocked by | not being archived | not archived, or any link row remaining |

The asymmetry is forced, not chosen: `clicks.domainId` is `NOT NULL`, so a click
has nowhere to go once its domain is gone.

### The one schema change

`apps/server/src/db/schema.ts:114` — `clicks.linkId` is `{ onDelete: "cascade" }`,
which would silently destroy the history a purge is meant to preserve. It becomes
`{ onDelete: "set null" }`. The column is already nullable and
`clicks_orphan_occurred_idx` already indexes `WHERE link_id IS NULL`, so the
orphan shape is waiting to receive them. Generate the migration with
`bun --filter @linq/server db:generate`.

`links.domainId` stays `restrict` — it already enforces the domain guard at the
database level, and the application check exists to turn that into a 409 rather
than a driver error. `clicks.domainId` stays `cascade`, which is what takes the
clicks with the domain.

### Files

- `packages/shared/src/permissions.ts` — add `can.purge(actor)` → admin,
  following the existing pure-predicate pattern.
  `apps/server/src/auth/permissions.ts` wraps it in a throwing helper alongside
  `assertCanEdit`.
- `apps/server/src/http/api/links.ts`, `.../domains.ts` — the two routes, beside
  the existing `DELETE /:id`.
- `apps/admin/components/common.tsx` — a stricter `ConfirmButton` variant that
  requires typing the slug or host before its confirm button enables.
- `apps/admin/app/links/detail/page.tsx`, `apps/admin/app/domains/page.tsx` — a
  Purge control, admins only, on archived resources only.

No audit table and no extra logging: the request middleware already records the
actor, route and status for every call.

### Documentation

- **Amend** `docs/adr/0002-archive-instead-of-delete.md`: the purge it foresaw
  now exists, admin-only and archived-first, and **purging a link releases its
  slug** — the anti-hijacking guarantee being consciously traded away.
- `CONTEXT.md` — two entries become false:
  - `:20` **Archived** — no longer "the **terminal** status", and "Nothing is
    hard-deleted" no longer holds.
  - `:6` **Slug** — "Reserved forever once used" becomes reserved for as long as
    the Link row exists.
  - Add **Purge**: the irreversible destruction of an archived Link or Domain,
    distinct from archiving.

---

## Sequencing

The two halves are independent. Geo first, because it is smaller and
self-contained.

1. Geo swap, then delete the MaxMind plumbing and the tar reader.
2. The `clicks.linkId` migration.
3. Purge routes, predicate, tests.
4. Admin UI: attribution footer, purge control.

## Verification

```bash
bun test apps/server/test      # 192 existing stay green
bunx tsc -b --force            # exit 0
bunx biome check .             # exit 0 — check the exit code, not the tail
bun --filter @linq/admin build # exports all 7 pages
```

**Geo.** `rules.test.ts:338-381` is load-bearing: same rule, same request,
stubbed geo returning IN redirects to `/in`, no-geo falls through to `/global`.
It must stay green. `redirect.test.ts:287-324`, proving no IP reaches the click
row, is unchanged. New tests: boot with no configuration yields a working
`lookup`; a failed download still leaves the server serving; the month-boundary
fallback picks the previous file on a 404.

Then verify once by hand against the real file — load it with `maxmind` and
assert `country.iso_code` on known IPs — **because the field shape was confirmed
from DB-IP's documentation, not by loading the file.**

**Purge.** New tests, each mirroring one that pins today's behaviour:

- Purging a non-archived link is 409; a non-admin is 403.
- **Purging frees the slug** — the deliberate inverse of `links.test.ts:45-62`
  ("refuses a slug already taken… archived ones included"), which must itself stay
  green, since archiving still does not release a slug.
- Purging a link leaves its clicks with `linkId` null, reachable through the
  orphan slice — the inverse of `rules.test.ts:211-219`, which proves archive
  leaves rules alone.
- Purging a link removes its rules.
- Purging a domain is 409 while any link row exists, archived ones included.
- Purging a domain removes its clicks, and global totals shrink accordingly.

## Risks

- **The DB-IP field shape is documented, not yet observed.** Verify against the
  real file before deleting the MaxMind path, not after.
- **Routing changes for roughly 5.5% of addresses.** Country rules will send some
  visitors somewhere other than they do today.
- **Attribution is a licence obligation**, not a nicety. Drop the UI link later
  and the CC BY 4.0 grant is no longer satisfied.
- **Purge is irreversible and leaves no trace** beyond a rotating log line. The
  typed confirmation is the only safety net, and it is client-side.
