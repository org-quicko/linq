# 0003 – Logs never persist client IPs

**Status**: accepted · 2026-09-15

> [0010](./0010-no-geolocation.md) removed geolocation and, with it, the last
> code that read the client address. This decision is unchanged and now has
> nothing left to guard against.

## Context

link now writes structured logs to a rotating file under `LINQ_DATA_DIR`, a mounted volume that survives restarts and is retained for `LINQ_LOG_MAX_SIZE × LINQ_LOG_RETAIN` of history. A conventional HTTP access log records the client address on every line.

ADR 0001 keeps the client IP out of the clicks table, so that clicks are not personal data and need no anonymisation, retention or access rules. A request log carrying the same address would put that personal data back on disk, for the same requests, and quietly reverse 0001 for the product as a whole — the table would stay clean while the volume next to it held the addresses.

The redirect path is also where the request log is least ordinary: a link forwards arbitrary customer query strings, which the log would otherwise copy verbatim.

## Decision

Request logs carry the request id, method, path, matched route, status, duration and the acting user id. They never carry the client address, the `x-forwarded-for` header, query string *values* (keys only, at debug level), or any response body.

There is no configuration flag to turn this on. The answer is *never*, not *off by default*.

The address was, when this was written, still read in-request for geolocation and dropped afterwards. Since 0010 it is not read at all.

## Consequences

- No per-IP abuse tracing, rate-limit forensics or "which address hit this link" question can be answered from the logs. The request id correlates a request across lines; nothing correlates two requests from one caller.
- ADR 0001's guarantee holds for the product, not only for one table, so neither the database nor the log volume needs anonymisation or retention rules.
- Response bodies are never logged, because `POST /api/v1/keys` returns a plaintext API key and a generic body logger would write every minted key to disk.
- A future contributor asked for "proper access logs" has to reopen this decision rather than add `x-forwarded-for` in a five-line change.
- If per-IP tracing becomes a requirement, the upgrade path is the same as 0001's: a salted, rotating hash, decided deliberately — not the raw address.
