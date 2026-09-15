# 0004 – Keyless geolocation database

**Status**: accepted · 2026-09-15

> Where the file lives and who owns it is settled in [0005](./0005-geo-database-is-an-external-cache.md).

## Context

A Click carries a coarse country, and a `country` Condition on a Rule chooses a Destination from it. The address itself is never stored (ADR 0001), so the database that resolves it is the only thing this depends on.

The original source was MaxMind GeoLite2, which serves a download only after an account, an accepted EULA and a licence key. For a self-hosted product that is a wall in the way of a default. An operator who will not sign up gets no database at all, which means every Click has a null country and **every `country` Condition silently fails**: the Rule never matches, and nothing reports that the cause was a missing licence key rather than a visitor from elsewhere. A feature that only works after paperwork is a feature most installs do not have.

The alternatives were narrow. IP2Location LITE requires an account and forbids redistribution. ipinfo.io Lite requires a token. CDN country headers cannot be the mechanism on their own: an operator whose origin is reachable directly receives attacker-controlled headers, and linq does not control how operators deploy it.

## Decision

linq uses **DB-IP Country Lite**, downloaded at boot from `download.db-ip.com` with no account, no token and no key, and refreshed when the local copy is older than 30 days. It is MMDB 2.0, so the same reader opens it and `country.iso_code` is the same field as before.

Country only. The region field stays in the schema, the API and the UI, but is null for every new Click: region lives in DB-IP's city database, which is fifteen times larger for a field whose use is not yet established. Adopting it later is a filename change, not a migration.

The file is published monthly with no `latest` alias, so a download tries the current UTC month and falls back to the previous one.

The database is licensed CC BY 4.0, which permits commercial use and redistribution, and — unlike GeoLite2's CC BY-SA — does not reach our own licensing. **Attribution is a condition of that licence**, so "IP Geolocation by DB-IP" appears wherever the Admin UI displays a result derived from it, and in `NOTICE`.

`LINQ_GEO_ENABLED` turns the download and the lookup off for an install with restricted egress, or one that would rather not call a third party at boot.

## Consequences

- Geolocation works on a fresh install with no configuration at all, which is what `country` Conditions have always assumed.
- **Country answers change.** DB-IP Country Lite agrees with GeoLite2 on roughly 94.5% of IPv4 space, so about one address in eighteen resolves differently. Since `country` Conditions choose Destinations, a small share of visitors will be routed somewhere other than they were before. Nothing fails; behaviour differs.
- Region is no longer recorded. Existing rows keep the values MaxMind gave them, and the two eras are not comparable in one report.
- Dropping the attribution from the UI ends the licence grant. It is not decoration.
- linq now makes an unauthenticated third-party request at boot by default. `LINQ_GEO_ENABLED=false` is the answer for an install that cannot, and a failed download has always left the server serving.
- The download is a plain `.mmdb.gz` rather than a tarball, so the hand-rolled tar reader is gone, and no secret appears in the download URL — which removes a class of log leak instead of guarding it.
