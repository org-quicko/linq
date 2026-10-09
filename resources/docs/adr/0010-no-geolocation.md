# 0010 – No geolocation

**Status**: accepted · 2026-09-17

Supersedes [0004](./0004-keyless-geolocation-database.md), which chose a vendor,
and [0005](./0005-geo-database-is-an-external-cache.md), which decided where its
file lived. Both are now moot: there is no file and no vendor.

## Context

linq resolved a coarse country for every Visit by downloading an 8 MB MMDB
database at boot and reading it with `maxmind`. The constraint that ended it is
not a complaint about the vendor, the licence or the accuracy — 0004 and 0005
had settled all three. It is simpler: linq should not call an external service
at boot, and should not carry a geolocation data file. Nothing replaces the
lookup.

There is no header-based fallback. 0004 already rejected CDN country headers as
the mechanism, and the reason has not changed: an origin reachable directly
receives attacker-controlled headers, and linq does not control how operators
deploy it. A location that a visitor can set is worse than no location.

Two features sat on top of the lookup, and neither survives its removal intact:

- The `country` Rule Condition compared against the resolved country. Left in
  place it would still be offered by the API and the UI, still be saved, and
  then never match — the exact silent failure 0004 was written to prevent, only
  permanent.
- `country` and `region` were rollup dimensions and `groupBy` values. Left in
  place they would keep answering, with every visit ever recorded collapsed into
  one bar labelled with the empty-string sentinel.

`region` was already dead: since the Country-Lite database of 0004 carries no
subdivisions, every Visit recorded under the current code has a null region.

## Decision

Geolocation is removed entirely, and nothing is left behind for it.

- The `maxmind` dependency, the download, the daily refresh timer and the
  `LINQ_GEO_ENABLED` / `LINQ_GEO_DB_PATH` / `LINQ_GEO_DIR` settings are gone.
  No switch survives for a subsystem that does not exist.
- **The `country` Condition is removed from the union**, not kept and rejected
  on write. A Condition is now `platform` or `query_param`.
- **Stored Rules carrying a `country` Condition are deleted**, whole, by the
  same migration. They are not repaired by stripping the Condition out:
  Conditions are ANDed, so removing one broadens the Rule. A Rule reading
  "country is IN and platform is android" would start matching every Android
  visitor anywhere — a silent rerouting of exactly the traffic it was written to
  exclude. Deleting it falls back to the Link's default Destination, which is the
  safe direction to fail in. Remaining Rules are renumbered so each Link's
  `position` sequence stays gapless.
- **`visits.country` and `visits.region` are dropped**, along with their two
  `visit_dimension` values, in migration `0006`. PostgreSQL cannot drop an enum
  value, so the type is rebuilt through `text`; the rollup rows holding the two
  doomed values are deleted first, and the trigger function is replaced before
  the columns go, so no visit can arrive between the two.
- **linq no longer reads the client address at all.** `clientIp()` had exactly
  one caller, the lookup, so it went with it — and with it `LINQ_TRUST_PROXY`
  and the Bun server handle that existed only to reach the peer address.
- The `NOTICE` file is deleted. Its entire content was the CC BY 4.0 attribution
  that 0004 required, and the `GeoAttribution` component that carried the same
  credit in the UI is deleted with it. An attribution is a condition of use; with
  nothing in use there is nothing to attribute, and a credit link to a vendor
  linq never calls is worse than none.

## Consequences

- **Country data is destroyed, not archived.** Migration `0006` deletes the
  `country` and `region` rollup rows outright. Re-introducing geolocation later
  is a fresh start, not a resumption. There is no down-migration.
- **The two columns are not equivalent losses.** Dropping `region` removes
  something no current code ever wrote. Dropping `country` removes a dimension
  that was genuinely populated. Only the second is a real reduction in what linq
  can report, and it should not be presented as uniformly cheap.
- **A Rule that depended on country is gone, not downgraded.** Anyone who had
  one loses that routing entirely and their Link serves its default Destination.
  That is intended — there is no honest way to keep a Rule whose premise no
  longer exists — but it is a live behaviour change on any database that had
  such Rules, and nothing warns the Link's owner that it happened.
- **A warm cache can outlive the migration.** The redirect caches a Link's Rules
  inside its target entry, so a process sharing Redis across a restart may hold
  a deleted `country` Rule until the entry expires. It cannot misroute: an
  unknown Condition type matches nothing, so the Rule is skipped exactly as if
  it were absent. The migration therefore does not flush the cache.
- ADR 0001's promise that the client IP is never stored now holds by
  construction: there is no code that reads it, so there is nothing to leak into
  a log line or a column by accident.
- linq makes no third-party network call at boot and ships no data file. An
  air-gapped install needs no configuration to be air-gapped.
- Bringing geolocation back means re-deciding 0004 and 0005 from scratch, under
  whatever constraint replaces this one. That is the intended cost.
