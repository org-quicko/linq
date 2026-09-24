# 0001 – Clicks never store the client IP

**Status**: accepted · 2026-09-15

> [0010](./0010-no-geolocation.md) removed geolocation, and with it the only
> reader of the client address. This decision still holds, and now holds by
> construction rather than by discipline: linq does not read the IP at all.

## Context

Every Click needs a coarse location (country, region), which is derived from the client IP at request time. Storing the IP as well would allow later re-geolocation, unique-visitor estimates and abuse investigation, but turns the clicks table into personal data that needs anonymisation rules, retention rules and access controls.

## Decision

The client IP is used in-request for geolocation only and is never persisted. Clicks store `country` and `region` and nothing that identifies the requester.

## Consequences

- No unique-visitor counts; analytics are click counts only.
- Location cannot be back-filled if the geo database was missing when a Click was recorded.
- No anonymisation or hashing logic to maintain; clicks are not personal data.
- If unique visitors become a requirement, the upgrade path is a salted, daily-rotated hash column, not the raw address.
