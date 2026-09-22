# linq — Plan 26: a domain with any link cannot be retired; a key with links cannot be demoted to viewer

Follows `docs/plans/Plan_25.md`.

## Context

Two guards, decided over discussion. Both are about the same shape of
mistake — removing a principal or a host while rows still depend on it —
but they land in different places and neither is a greenfield feature.

### 1. Domain deletion is already guarded; the bar moves and the holes close

Read before planning, and worth stating plainly because it changes what
this plan is: **`apps/server/src/http/api/domains.ts` already refuses both
deletes.** `assertNoActiveLinks` (:94-109) guards the archive on both
paths that reach it — `DELETE /:id` (:167) and `PATCH /:id` with
`status: "archived"` (:144) — and `assertNoLinksAtAll` (:76-91) guards the
purge (:190), counting archived links too. Both throw
`ApiError.conflict`. Both are tested (`apps/server/test/domains.test.ts:79`,
`:100`, `:112`). `docs/adr/0002` §Amendment states the two-tier rule
deliberately: archiving counts active links, purging counts every link.

So the decision here is **not** "add the guard". It is:

- **Raise the archive bar to match the purge bar**: any link row at all,
  archived included, refuses the archive. Requested explicitly, with the
  cost accepted (below). This collapses `assertNoActiveLinks` and
  `assertNoLinksAtAll` into one predicate and **amends `docs/adr/0002`**,
  whose current text says the opposite in two places.
- **Close two real holes in the existing guards**, found by reading the
  handlers rather than assumed:
  - The archive check and the `UPDATE` are two statements with no
    transaction and no lock, and `POST /links` reads `domains` and inserts
    with no lock either (`api/links.ts:191-211`). Two concurrent requests
    interleave into exactly the state `0002` says cannot exist: an active
    link on an archived domain. This one is a genuine correctness bug, not
    a hardening exercise, because `status` is a plain column with no
    database-level backstop.
  - The purge check and the `DELETE` race the same way, but there the
    database *is* the backstop: `links.domain_id` is
    `onDelete: "restrict"` (`db/schema.ts:64`), so Postgres refuses.
    Verified. The consequence is only that the refusal arrives as an
    unhandled FK violation, which `app.ts:48-56` turns into a generic
    **500** instead of the 409 the same request would get a millisecond
    earlier. The data is safe; the error is a lie.

  That asymmetry — archive needs a lock because nothing else protects it,
  purge needs an error mapping because something already does — is the
  organising idea of Part A and should survive review intact.

**The cost of the stricter archive bar, accepted knowingly.** Archived
links are kept forever (`0002`), and the only way to remove one is
`DELETE /links/:id/purge`, admin-only and archived-first. So after this
change, retiring a host that ever carried links means purging every one of
them first — for a domain with 500 links, that is 500 admin purges through
an API that has no bulk operation. This is named here rather than
discovered later; a bulk link purge scoped to a domain is the obvious
follow-up if it bites, and is deliberately **not** in this plan.

### 2. Key demotion — this supersedes `docs/plans/Plan_25.md` §A5

Plan 25 §A5 ruled this out of scope, and gave reasons: refusing the
demotion "holds an access *reduction* hostage to data cleanup — precisely
what `docs/adr/0011` refuses to do for revocation". That objection is
answered rather than overruled, and the answer is the reason this plan
works:

- The demotion is never blocked *without a one-call remedy*. A new bulk
  reassign endpoint moves every link the key owns in one request, either
  to another key or to nobody.
- **Revocation is untouched.** `DELETE /keys/:id` still succeeds
  immediately and still leaves the links unowned via `ON DELETE SET NULL`.
  That is the path `0011` actually protects — "a credential you cannot
  revoke on demand is not a credential you control" — and it remains the
  one-call escape for an urgent case. Demotion is a housekeeping
  operation, not an incident response; revocation is the incident
  response, and it is still one call.
- `0011` already treats **unowned as a legitimate resting state** ("the
  links survive, unowned, editable by a manager or admin and adoptable by
  transfer"). That is what makes `to: null` defensible rather than a
  data-loss shortcut: it is the exact state revocation already produces.

Plan 25 §A5's text and `can.editLink`'s comment must both be updated when
this lands, or the repo will carry a written decision it no longer
follows.

**On the wording of the request.** It said "if they have created any
*keys*". Taken literally that is unimplementable today and probably not
intended: `api_keys` has no owner or creator column (verified —
`id, name, role, key_hash, prefix, expires_at, created_at, updated_at`),
so the rule would need a new `created_by` column plus a backfill decision
for every existing key, and "you minted a key once, so you may not be
demoted" is a rule with no stated purpose. `links.owner_id → api_keys.id`
is the only ownership edge in the schema, and the remedy named in the
request — transfer to someone else, or leave unassigned — describes that
column exactly. Confirmed with the requester before planning: **links.**

---

## Part A — a domain with any link cannot be archived or purged

### A1. One predicate instead of two

`apps/server/src/http/api/domains.ts` — replace `assertNoActiveLinks` and
`assertNoLinksAtAll` with a single helper, since after this change both
callers ask the same question:

```ts
/**
 * A domain may be retired only when nothing points at it — archived links
 * included. Archiving stops the host serving and purging takes its visits
 * with it, and an archived link still owns its slug on that host
 * (docs/adr/0002), so either operation would strand a row that has nowhere
 * to go. Purging the links is the only way through, by design.
 */
function assertNoLinks(db: Db, domainId: string): Promise<void> {
  return span(
    "domain.assertNoLinks",
    async () => {
      const [{ n }] = await db
        .select({ n: count() })
        .from(links)
        .where(eq(links.domainId, domainId))
      if (n > 0) {
        throw ApiError.conflict(`domain still has ${n} link${n === 1 ? "" : "s"}; purge them first`)
      }
    },
    { in: { domainId } },
  )
}
```

`count()` rather than the existing `limit(1)` probe: the number is what the
operator needs to decide what to do next, and the remedy is now "purge
them", not "archive them", so both existing messages are wrong as written.
The count is served by the `links_domain_slug_key` unique index on
`(domain_id, slug)` as a leading-column prefix, so it costs no more than
the probe did at these sizes.

Call it from all three sites: `DELETE /:id` (:167), the
`patch.status === "archived"` branch (:144), and `DELETE /:id/purge`
(:190).

### A2. The archive race, and the row lock that closes it

The interleaving, spelled out because it is the one part of this plan that
is a bug fix rather than a policy change:

```
T1  DELETE /domains/D   SELECT … FROM links WHERE domain_id = D   → none
T2  POST   /links       SELECT … FROM domains WHERE id = D        → active
T2                      INSERT INTO links (domain_id = D)          COMMIT
T1                      UPDATE domains SET status='archived'       COMMIT
```

Both requests are individually correct and the result is an active link on
an archived domain — the state `0002` guarantees against. Nothing in the
schema prevents it: `status` is a plain enum column, so unlike the purge
path there is no database-level backstop to fall back on.

Fix by serialising the two on the domain row:

- **Archive** (`DELETE /:id`, and the `status === "archived"` branch of
  `PATCH /:id`): open a transaction, take
  `SELECT … FROM domains WHERE id = ? FOR UPDATE`, then `assertNoLinks`,
  then the `UPDATE`.
- **`POST /links`** (`api/links.ts:191-211`): open a transaction, take
  `SELECT … FROM domains WHERE id = ? FOR SHARE`, keep the existing
  `notFound` / `conflict("domain is archived")` checks, then `insertLink`.

`FOR SHARE` conflicts with `FOR UPDATE` but not with itself, so concurrent
creates on one domain still run in parallel and only the archiver blocks
them. Under READ COMMITTED — the default, and nothing in this repo changes
it — a plain transaction without the lock would **not** close the race, so
the lock is the mechanism, not the transaction. Say that in the comment;
it is the thing a future reader will be tempted to simplify away.

Two implementation notes, both checked rather than assumed:

- `Db` is `PgDatabase<PgQueryResultHKT, typeof schema>`
  (`apps/server/src/db/client.ts:9`), and drizzle's `PgTransaction`
  extends `PgDatabase`, so `assertNoLinks(tx, id)` and `insertLink(tx, …)`
  typecheck with **no signature widening** — resist the urge to add a
  `Db | Transaction` union. Confirm the generic parameters line up at
  implementation time.
- `db.transaction(async (tx) => …)` is already used in this repo at
  `api/rules.ts:47`, so the pattern needs no introduction. The row-locking
  builder (`.for("update")` / `.for("share")`) should be confirmed against
  the installed drizzle version's types before use — the same
  run-it-and-check step Plan 24 §A took for `ua-parser-js`.

`insertLink` retries up to five times on slug collision
(`api/links.ts:133-143`); all five attempts run inside the one
transaction, which is correct — they are already sequential — but it does
mean the domain's `FOR SHARE` lock is held for the duration. Acceptable:
`POST /links` is an authenticated write, not the redirect path, and the
lock is a single row on a table with a handful of rows.

**Rejected: an exclusion constraint or a trigger** enforcing "no active
link on an archived domain" in the database. It would be airtight without
any locking, but it is a cross-row rule over two tables, which means a
trigger on both `links` and `domains`, written in plpgsql, hand-appended to
a generated migration, and re-derived by every reader. The repo has
exactly one trigger (`record_visit_rollup`, `docs/adr/0007`) and it earns
its place by replacing an unbounded aggregate on a hot path. A two-row
lock on a cold path does not clear that bar.

### A3. The purge race, which is an error-mapping bug

Leave the purge's ordering as it is — check, then delete — and take the
same `FOR UPDATE` transaction for consistency with A2. Then add the
backstop, because the FK is the real authority and the pre-check exists
only to produce a readable message:

```ts
    // The pre-check above is for the message; `links.domain_id` is ON DELETE
    // RESTRICT, so Postgres is what actually guarantees this. A link created
    // between the two would otherwise surface as an unhandled FK violation,
    // which app.ts reports as a 500 — a worse answer than the 409 the same
    // request would have got a moment earlier.
    catch → if (isForeignKeyViolation(err)) throw ApiError.conflict("domain still has links; purge them first")
```

Map Postgres `SQLSTATE 23503` locally, in the purge handler, **not** in
`app.onError`. A global mapping would turn every FK violation anywhere in
the app into a 409 carrying a message about domains, and would hide the
next genuine referential bug behind a plausible-looking client error.

`visits.domain_id` is `onDelete: "cascade"` (`db/schema.ts:110-112`), so
visits never block a purge and are destroyed with the domain, exactly as
`0002` §Amendment describes. Verified; no change needed, but it is the
reason `23503` can only ever mean "links".

### A4. `Domain.linkCount` changes meaning

`domainQuery` (:41-56) counts **active** links, and its doc comment says
why: "Archived ones are excluded because this count is what decides
whether the domain may be archived." After A1 that sentence is false
unless the count changes with it. Drop the `where(eq(links.status,
"active"))` so the count is every link row, and rewrite the comment to say
the invariant it is now preserving: *the number shown is the number that
must reach zero.*

This is an **observable change to a shipped API field** — same name, same
type, different number — and it is the one thing in this plan a consumer
could notice without reading the changelog. Called out in Risks. The
alternative, keeping `linkCount` active-only and adding a second
`totalLinkCount`, was rejected: two counts on the domain row invite the
reader to ask which one the rule uses, which is precisely the confusion the
single count exists to prevent.

`apps/server/test/domains.test.ts:63` ("counts only active links") asserts
the old behaviour and must be rewritten, not deleted — it becomes "counts
every link, archived included".

### A5. Client

- `apps/client/app/domains/page.tsx:21` — `HEAD`'s "Active links" becomes
  "Links".
- :144 — the `ConfirmButton` description says "The server refuses this
  while the domain still has active links"; it becomes "…while any link,
  archived included, still points at this host. Purge them first."
- :23-28 — the page's own doc comment states a deliberate decision: the
  refusal is "surfaced here rather than pre-empted, so the rule lives in
  one place". **Keep that.** Do not disable the Archive button on
  `linkCount > 0`. The row already shows the count, the server message now
  names it too, and pre-empting would put the rule in a second place —
  which is the thing that comment exists to prevent. (Noting the
  alternative because it is the obvious review suggestion: it reads better
  and costs a duplicated rule. Not worth it.)
- `apps/client/app/domains/trash/page.tsx:41-43` already describes the
  purge rule correctly ("refuses while any link, archived included, still
  points at the host") — no change, and it is now also the archive rule,
  which is worth a glance to confirm the two pages no longer contradict
  each other.

### A6. `docs/adr/0002` amendment

`0002` states the two-tier rule in two places — the Decision ("A Domain can
be archived only when it has no active Links") and the Amendment ("A Domain
is refused while **any** Link row still points at it… a stricter bar than
archiving, which only counts active ones"). Both become wrong.

Add a second amendment rather than editing the accepted text, following
how the Purge amendment was appended: the archive bar is raised to match
the purge bar; the reason is that an archived link still holds its slug on
that host and an archived domain cannot serve it, so the pair is a dead
end that the old rule allowed you to create silently; and the cost is the
one named in Context — retiring a host that ever carried links now means
purging each one, with no bulk operation to do it. State that cost in the
ADR, because it is the part a future reader will want the reasoning for.

### A7. Tests

`apps/server/test/domains.test.ts`:

- Rewrite `:63` per A4.
- `:79` ("refused with 409 while an active link exists") stands.
- **New**: archiving is refused while only an *archived* link exists —
  the rule change, and the test that fails today.
- **New**: a domain whose links have all been purged archives cleanly,
  proving the rule is escapable.
- **New**: purging is refused with **409, not 500**, while an archived
  link exists — the `assertNoLinksAtAll` path has no direct test today
  (`:200` only covers the happy path), and this is also the regression
  test for A3's mapping if the pre-check is ever removed.
- `:112` ("a link cannot be created on an archived domain") stands and
  now also exercises the `FOR SHARE` path.

The A2 race itself is not directly testable without two concurrent
connections, which the PGlite harness does not provide. Do not fake it
with a mocked clock; instead assert the mechanism is present — the archive
path runs inside a transaction and takes the lock — and record here that
the guarantee rests on the lock rather than on a test. This is the one
claim in the plan that ships unproven by the suite, and it should be
called out in review rather than glossed.

---

## Part B — a key that owns links cannot be demoted to viewer

Depends on **Plan 25 Part A** for `can.ownLink`. If Part B lands first,
define `can.ownLink` here and let Plan 25 Part A drop its §1 duplication.

### B1. The rule

`apps/server/src/http/api/keys.ts`, in `PATCH /:id`, after the existing
self-role guard at :94-96 (which stays first — it is cheaper and it is
about the caller, not the target, so a key cannot demote *itself* into
this state at all):

```ts
    // A viewer may not own links (can.ownLink), so demoting a key that owns
    // some would strand them: editable by a manager or admin, and by nobody
    // else, including the key still named as the owner. Reassigning is one
    // call — see POST /keys/:id/links/reassign — and revoking the key
    // outright is still unconditional (docs/adr/0011).
    if (patch.role !== undefined && !can.ownLink({ role: patch.role })) {
      const [{ n }] = await c.var.db
        .select({ n: count() })
        .from(links)
        .where(eq(links.ownerId, id))
      if (n > 0) {
        throw ApiError.conflict(
          `key owns ${n} link${n === 1 ? "" : "s"}; reassign them before demoting it to viewer`,
        )
      }
    }
```

Phrased as `!can.ownLink({ role: patch.role })` rather than
`patch.role === "viewer"` so the rule tracks the ownership threshold
wherever it moves, instead of naming the one role that currently sits
below it. This is the payoff for Plan 25 §A1 taking `{ role: Role }`
instead of `Actor`.

409 for the same reason Plan 25 Part A §2 gives: the caller is permitted,
the request fights the current state. `links_owner_id_idx`
(`db/schema.ts:83`) serves the count.

### B2. The bulk reassign endpoint

```
POST /api/v1/keys/:id/links/reassign     { "to": "<uuid>" | null }  →  { "moved": 14 }
```

- **Permission: `assertCanTransfer(c.var.principal, id)`** — reuse the
  existing helper (`auth/permissions.ts:26`), passing the *source key id*
  where it expects an owner id. It evaluates
  `actor.role === "admin" || (actor.keyId === id && roleAtLeast(actor.role, "author"))`,
  which is exactly right without a new predicate: an admin reassigns any
  key's links, and anyone else may bulk-reassign only their own key's —
  the same sentence `can.transferLink`'s comment already carries for a
  single link.
- **Target validation**, mirroring Plan 25 Part A §2 so the bulk path and
  the per-link path cannot refuse different things: `null` is always
  allowed and means unassign; otherwise the key must exist (404) and must
  satisfy `can.ownLink` (409, same message).
- One `UPDATE links SET owner_id = ?, updated_at = now() WHERE owner_id = :id`
  — a single statement, so it is atomic without a transaction. Return the
  affected count.
- **`updated_at` is bumped.** Reassignment is a modification and the
  per-link `PATCH` already bumps it; leaving it alone would make Plan 25
  Part B's "Updated" column lie about a change the operator just made. The
  interaction is real and worth stating: a bulk reassign reorders that
  sort for every link it touches. That is honest behaviour, not a
  side effect to suppress.
- **No cache invalidation, deliberately.** Every other link mutation calls
  `cache.del(targetKey(...))`, so a reviewer will expect one here.
  Ownership is not in `ResolvedTarget` (`http/redirect.ts:24-31` — verified:
  `linkId`, `name`, `destination`, `forwardQuery`, `presetParams`,
  `rules`), and if Plan 25 Part D lands, ownership is not in the rendered
  `/llms.txt` either. Nothing cached reads `owner_id`. Put that sentence
  in the handler, because the absence is the surprising part.
- **Rejected: an inline `{ role: "viewer", links: "unassign" }` parameter
  on `PATCH /keys/:id`.** One round trip instead of two, but it overloads
  a key patch with an unbounded write across another table, and it makes
  the destructive half invisible in the request that performs it —
  `{"role":"viewer","links":"unassign"}` does not look like "and detach
  fourteen links". A separate endpoint names what it does.
- The endpoint stands on its own merit beyond this rule: `0011` describes
  rotation as "mint, transfer, revoke" and notes it is "a three-step
  operation someone has to remember", where the transfer step is today one
  call per link. This makes it one call.

### B3. What does not change

- **`DELETE /keys/:id` (revocation) is untouched.** It still succeeds
  regardless of how many links the key owns, leaving them unowned via
  `ON DELETE SET NULL`. `0011` is unambiguous that this must hold, and it
  is the escape hatch that keeps B1 from being a lock-in. Add a test
  asserting revocation still works on a link-owning key, so a future
  reader who finds B1 does not "fix" the inconsistency.
- Demotion to `manager` or `author` is unaffected — both clear
  `can.ownLink`.

### B4. Client

`apps/client/app/settings/keys/page.tsx` — the role `Picker` at :119-123
saves immediately on change (`onChange={(role) => save({ role })}`), and
`save` surfaces the server error through `errorMessage`, so the 409 lands
as a toast with the count in it and the Picker reverts on refetch. That is
adequate on its own, and it keeps the rule in one place, consistent with
the call made in A5.

Worth adding, because the toast tells the operator what is wrong but not
where to go: when the demotion is refused, offer the remedy in the same
place — a small "Reassign links" action on the key row, opening a picker
of eligible target keys (filtered by `can.ownLink`, exactly as Plan 25
Part A §4 filters the link-detail owner dropdown) plus an explicit
"Leave unassigned" choice, calling the B2 endpoint. Without it, the
operator is told to reassign and given no way to do it short of editing
links one at a time — which is the workflow this part exists to remove.

### B5. Plan 25 and ADR 0011 upkeep

- `docs/plans/Plan_25.md` §A5 currently argues this should not be built. Append
  a note that Plan 26 supersedes it and why the objection is answered —
  do not silently delete it; the reasoning is still the reason revocation
  stays unconditional.
- `can.editLink`'s comment (rewritten in Plan 25 §A1 to say demotion is
  the one remaining path to a viewer-owned link) needs a second pass: after
  this plan, demotion is refused too, so the only remaining path is a key
  demoted *before* this shipped. Say that, and say that such rows are
  tolerated rather than migrated.
- `docs/adr/0011` gets a sentence in Consequences: a key's role may not be
  lowered below the ownership threshold while it owns links, and
  reassignment or revocation is the way through. No new ADR — this is a
  clarification of 0011 and of 0002, not a new irreversible decision.

### B6. Tests

`apps/server/test/keys.test.ts`:

- Demoting a link-owning key to `viewer` → 409, the message names the
  count, and the stored role is unchanged.
- Demoting the same key to `manager` or `author` → 200 (the rule is the
  ownership threshold, not the word "viewer").
- Demoting a key that owns nothing to `viewer` → 200.
- Reassign to another key → `{ moved: n }`, the links' `ownerId` and
  `ownerName` follow, and the demotion then succeeds.
- Reassign with `to: null` → links are unowned, and the demotion then
  succeeds.
- Reassign to a **viewer** key → 409, same message as the per-link
  transfer in Plan 25 §A6.
- Reassign to an unknown uuid → 404.
- A non-admin author reassigning **its own** key's links → 200; the same
  author reassigning **another** key's links → 403 (`assertCanTransfer`).
- **Revoking** a link-owning key still returns 204 and leaves the links
  unowned — the `0011` guard rail, per B3.

`apps/server/test/links.test.ts`: after a bulk reassign, the affected
links' `updatedAt` has moved (guards B2's deliberate bump against a future
"optimisation" that drops it).

---

## Sequencing

Parts A and B are independent — different tables, different handlers, no
shared helper. Either order.

Within Part A: A1 (the predicate) → A2/A3 (the transactions) → A4 (the
count) → A5 (client copy) → A6 (the ADR amendment) → A7. A4 must not ship
without A1, or the UI shows a number that does not match the rule.

Within Part B: B2 (the endpoint) **before** B1 (the refusal), so the
remedy exists before anything starts pointing at it. Shipping B1 first
leaves an operator blocked with an error message naming an endpoint that
returns 404.

Part B depends on Plan 25 Part A for `can.ownLink` — see B intro.

## Verification

```
bun test apps/server/test/domains.test.ts apps/server/test/keys.test.ts \
         apps/server/test/links.test.ts
bun run test
bun run typecheck
```

No migration in this plan: both parts are handler and permission changes
over the existing schema. `bun run db:generate` should produce nothing —
worth running once to confirm that, since an accidental schema edit would
otherwise ride along silently.

Manual, against the local stack (see `.claude/skills/linq-dev`):

1. On a domain with one archived link and no active ones, press Archive →
   refused, and the toast names the count. Purge the link, press Archive
   again → succeeds. This is the whole rule change in two clicks.
2. With the domain archived and empty, purge it from Domains trash →
   succeeds and its visits go with it.
3. `curl -X PATCH .../api/v1/keys/:id -d '{"role":"viewer"}'` on a key
   that owns links → 409 naming the count, not a 500 and not a silent
   success. `POST .../keys/:id/links/reassign -d '{"to":null}'` →
   `{ moved: n }`, the links show no owner in the UI, and the PATCH then
   returns 200.
4. Revoke a different link-owning key → 204, and its links appear unowned
   rather than disappearing from the list (the `leftJoin` guarantee `0011`
   names).
5. Race check, by hand, since the suite cannot: with the server running,
   fire `DELETE /domains/:id` and `POST /links` for that domain in a tight
   loop from two shells and confirm no active link ever ends up on an
   archived domain. Not a test, but the only direct evidence A2 works.

## Risks

- **`Domain.linkCount` changes meaning** (A4) — same field, same type, a
  different number. Any consumer reading it as "live links on this host"
  is silently wrong afterwards. Judged acceptable because the field's
  stated purpose is to predict the archive refusal, and it only keeps that
  purpose by changing; but it is the one externally visible break here.
- **Retiring a domain becomes a long manual job** (Context). For a host
  with hundreds of links there is no bulk purge, so the stricter bar
  converts a one-click operation into hundreds. Accepted deliberately; the
  follow-up, if it bites, is a domain-scoped bulk link purge, not a
  relaxation of the rule.
- **The archive race fix ships without a test** (A7). The PGlite harness
  has no second connection, so the lock's correctness rests on review and
  on the manual check above. Flagged rather than papered over with a test
  that would pass either way.
- **Row locking on `POST /links`** (A2) is a new blocking point on a write
  path. One row, on a small table, on an authenticated route — but if
  `insertLink` ever grows slower (more slug retry attempts, a longer
  `LINQ_SLUG_LENGTH` search), the archiver waits on it.
- **Part B reverses a written decision** (Plan 25 §A5). The reversal is
  sound because the remedy and the untouched revocation path answer the
  original objection, but §A5 and `can.editLink`'s comment must both be
  updated in the same change or the repo documents a rule it no longer
  follows.
- **Pre-existing viewer-owned links are tolerated, not migrated.** A key
  demoted before this ships may still own links, and nothing in this plan
  finds or fixes them. Consistent with the forward-only stance every prior
  plan here has taken, and the reassign endpoint is the manual cure.
