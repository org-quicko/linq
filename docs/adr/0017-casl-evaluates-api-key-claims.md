# 0017 – CASL evaluates API-key claims

**Status**: accepted · 2026-09-24.

Extends [0011](./0011-the-api-key-is-the-principal.md) and [0016](./0016-links-are-unowned-editor-replaces-author-and-manager.md).

## Context

An API key is linq's only principal. It currently holds exactly one value from
the ordered `viewer < editor < admin` role ladder, and `@linq/shared` converts
that value into hand-written `can.*` predicates. That was small and clear while
each responsibility formed one strict hierarchy. It cannot express a key that
needs a combination of responsibilities without either granting the next broad
role or adding another role and changing every comparison that assumes a
ladder.

The Client UI also uses the same predicates to hide actions it knows the server
will refuse. That shared policy is useful, but the server remains the authority:
an API key is a bearer credential and a UI check is not an access-control
boundary.

CASL represents an ability as a set of action-and-subject rules, can evaluate
the same rules in TypeScript on both server and client, and can serialize a
restricted rule set. It therefore fits the existing single-key principal model
without bringing back users, ownership, or a database lookup per permission.

## Decision

**A key carries explicit claims, and CASL evaluates them.** `api_keys.claims`
will contain a validated JSONB array of CASL-compatible rules. The canonical
initial rule shape is `{ action, subject }`; both fields are closed unions owned
by `@linq/shared`. The shared package will export one typed ability factory;
the authentication middleware builds it from the authenticated key's claims,
and every server route asks that ability before acting. The Client UI builds the
same ability from `/me` only to present appropriate controls.

**Persist grants, not a single role.** `viewer`, `editor`, and `admin` survive
as named presets that expand to explicit claims when creating or editing a key.
They are a convenient way to reproduce today's grants, not a stored hierarchy
or a prerequisite to combine grants. `role`, role-ranking helpers, and the
`--role` CLI option are removed rather than retained as
aliases.

**The change is a direct cutover, not a compatibility migration.** The current
environments are disposable, so their databases are recreated before the
claims-only schema is deployed. Existing API keys and their secrets are
intentionally discarded; with an empty `api_keys` table, the existing bootstrap
mechanism mints a replacement admin key carrying the `admin` preset. There is
no dual role/claim read, role-to-claim backfill, response compatibility field,
or deprecated API or CLI path.

**Claims are deliberately narrow in the first release.** Valid subjects are
the resources linq already authorizes (`Link`, `Rule`, `QrCode`, `Domain`,
`Key`, `Analytics`, and `Visit`), and valid actions are the concrete API
operations (`read`, `create`, `update`, `archive`, `restore`, `purge`, and
`delete`). The API rejects CASL's `manage` and `all` wildcards, client-supplied
conditions, field grants, inverted rules, and unknown JSON
properties. CASL's richer conditional abilities are reserved for a later ADR
that defines a resource boundary and condition language; accepting arbitrary
Mongo-like predicates now would make an API-key payload an unbounded policy
language.

**CASL does not replace non-authorization invariants.** A missing, revoked, or
expired key remains a 401; authorization remains a 403. Validation, resource
state transitions, and the safeguards preventing a key from changing or
revoking itself remain explicit route logic. The key continues to be the
principal, links remain unowned, and authorization continues to need no join,
as decided by 0011 and 0016.

## Consequences

- A key can receive a least-privilege combination of claims without growing the
  PostgreSQL role enum or forcing an artificial total order on responsibilities.
- Server and client share CASL types and ability construction, reducing drift;
  nevertheless, every API route must still authorize on the server and tests
  must cover denied neighbors as well as granted paths.
- The key API, `/me`, CLI, schema, and Keys UI change from a scalar role to
  claim lists in one breaking release. Recreating an existing database is
  required before deployment; old API keys stop working and must not be treated
  as recoverable credentials.
- The PostgreSQL `role` enum is temporarily retained as an unused database
  type: Drizzle generates a valid column drop only when it preserves the enum
  in that migration. No running code reads or writes it; its eventual removal
  is schema housekeeping, not a compatibility path.
- Persisted rules make policy review possible, but their closed schema means an
  operator cannot express arbitrary resource conditions yet. New conditional
  claims require a separate decision about their semantics, validation,
  indexing, and test strategy.
- `@casl/ability` becomes a shared runtime dependency. It replaces bespoke
  role-ranking and `can.*` evaluation; keeping either as a transition path
  would create two competing sources of truth and is not permitted.
- A future production migration that must preserve keys or public API clients
  needs its own ADR. It must define the data-conversion and rollback guarantees
  before reintroducing any compatibility path.
