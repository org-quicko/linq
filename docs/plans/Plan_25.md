# linq — Plan 25: link expiry, an opt-in `/llms.txt`, sort keys, and the viewer-owner rule

Follows `docs/plans/Plan_24.md`.

## Context

Four changes to the link model, decided over discussion. They are grouped
into one plan because Parts C and D touch the same four shared-schema
spots (`linkCreateSchema`, `linkPatchSchema`, `toLink`, the `Link` type)
and the same two client forms — planning them apart would have produced
two plans that contradict each other on the same lines.

1. **Links have no expiry.** A link lives until someone archives it, so a
   campaign link or a time-boxed share has to be turned off by hand.
   `api_keys.expires_at` already exists and is enforced at read time in
   `apps/server/src/auth/middleware.ts:42` with no sweeper anywhere —
   that is the precedent this follows, deliberately: nothing in this repo
   runs on a timer, and a background job that archives lapsed links would
   be the first, for no gain over a comparison the redirect already has
   the data to make. Decided: an expired link resolves **exactly like an
   unknown slug** — the domain's `fallback_url` if set, else 404, with the
   visit recorded on the orphan path at `link_id = null`. Rejected:
   a dedicated 410, which would need its own branch in the redirect, its
   own preview-crawler handling and its own fallback semantics, to
   communicate a distinction no visitor acts on. Rejected: a per-link
   "expired destination" column, which is `rules` with a clock —
   revisitable if anyone asks, but not worth a column on a guess.

2. **Nothing linq serves is discoverable.** A crawler that already knows a
   short URL can follow it, but there is no catalogue, so an LLM has no
   way to enumerate what a domain publishes. `/llms.txt` is the
   convention to answer that with. Decided: **opt-in per link**, a new
   `listed` boolean defaulting to false. Rejected: listing every active
   link. `/llms.txt` cannot require a key and still do its job, so the
   default decides what an unauthenticated stranger can enumerate — and
   a short link's *destination* is frequently the interesting secret (an
   unannounced campaign, a doc behind SSO). An opt-out default publishes
   every one of them the moment this ships, and a crawl is not
   recoverable. Confirmed by searching `.ts/.tsx/.md/.json/.sql` that no
   `llms.txt`, sitemap or link-index code exists today; the only
   crawler-facing surfaces are `app.ts:84`'s one-line `robots.txt` and
   `redirect.ts:230`'s `ogPreview`, which serves social preview crawlers
   only (`isPreviewCrawler`, `apps/server/src/visits/bot.ts:26`,
   deliberately excludes search crawlers).

3. **The list sorts by two keys.** `linkListQuerySchema.sort` is
   `["createdAt","visits"]`. Note that `order: ["asc","desc"]` **already
   exists and already works** (`links.ts:178`) — verified by reading both
   files; the client simply never sends it (`LinkFilters` in
   `apps/client/lib/store/links.ts:5-13` has no `order` field, and
   `Filters` in `app/links/page.tsx:31-35` has no `order`). So the server
   half of this is the enum plus a column map, and the rest is a client
   gap.

4. **A viewer key can be handed a link.** `can.editLink` refuses a viewer
   even over its own link, so a transfer to a viewer produces a link
   nobody below manager can edit. The hole is already acknowledged in
   prose at `packages/shared/src/permissions.ts:26-32` ("A viewer that
   happens to own a link, through a transfer, still cannot change it") —
   this plan closes the transfer path and rewrites that comment to name
   the one path that remains.

---

## Part A — viewer keys cannot own links

No schema change and no dependency on the other parts. Smallest; do it
first.

1. **`packages/shared/src/permissions.ts`** — add a predicate for *who
   may hold* a link, and make `createLink` delegate to it:

   ```ts
     /**
      * Who may hold a link. A viewer may not: `editLink` refuses a viewer
      * even over its own link, so a viewer-owned link would be one nobody
      * but a manager could touch.
      */
     ownLink: (target: { role: Role }): boolean => roleAtLeast(target.role, "author"),

     /** Anyone who may own a link may create one. */
     createLink: (actor: Actor): boolean => can.ownLink(actor),
   ```

   The parameter is `{ role: Role }` rather than `Actor` so the server can
   pass a selected `api_keys` row without fabricating a `keyId`; `Actor`
   still satisfies it structurally, so the `createLink` delegation
   typechecks unchanged. The payoff is that `createLink`'s existing doc
   comment — "Anyone who may own a link may create one" — becomes
   literally true rather than aspirationally true, and the two rules can
   no longer drift apart.

   **Rejected: giving `can.transferLink` a target-role parameter.** It
   answers "may *this actor* hand *this link* over", and its only UI
   caller (`apps/client/app/links/detail/page.tsx:90`, which decides
   whether the Owner picker is enabled at all) asks it *before* a target
   is picked — there is no role to pass. Conflating the two questions
   breaks that call site and muddies a predicate whose current comment is
   exactly right.

   Also rewrite `can.editLink`'s comment: after this change a viewer can
   no longer acquire a link by transfer, and the one path that remains is
   a key that owned links and was later demoted (see §5).

2. **`apps/server/src/http/api/links.ts:226-234`** — the PATCH handler
   already loads the target key to 404 on an unknown uuid; select its
   role too and refuse:

   ```ts
       const [owner] = await c.var.db
         .select({ id: apiKeys.id, role: apiKeys.role })
         .from(apiKeys)
         .where(eq(apiKeys.id, patch.ownerId))
         .limit(1)
       if (!owner) throw ApiError.notFound("key")
       // Not 403: the caller is allowed, the *target* is not eligible.
       if (!can.ownLink(owner)) throw ApiError.conflict("a viewer key cannot own a link")
   ```

   The existence check stays first, so a typo'd uuid still 404s rather
   than being reported as a role problem.

   **409, not 403 or 404.** `ApiError.forbidden`'s default message is
   "insufficient permissions", which here would tell an admin their *own*
   key was demoted — the caller is in fact allowed. 404 sends them
   hunting for a uuid that exists. `ApiError.conflict` is the one whose
   meaning fits, and there is direct precedent in this same file:
   `POST /links` throws `conflict("domain is archived")` for the
   identical shape, a referenced resource whose current state refuses the
   operation.

   `POST /links` itself needs no change — `assertRole(principal,
   "author")` already refuses viewers, and after §1 it and `can.ownLink`
   are the same rule expressed once.

3. **`packages/shared/src/keys.ts:34`** — `ApiKeySummary` gains
   `role: Role`, and **`apps/server/src/http/api/keys.ts:56`** returns it:

   ```ts
         isAdmin ? toApiKey(row) : { id: row.id, name: row.name, role: row.role },
   ```

   The route's doc comment at `keys.ts:35-41` currently says the opposite
   — "a prefix or a role is more than that job requires" — so it must be
   rewritten in the same commit or a reviewer will rightly flag the
   contradiction. The new rationale: the UI must not offer a transfer
   target the server will refuse, and that rule is a function of the
   target's role, so the role is now part of the minimum. What stays
   admin-only is what actually matters — `prefix`, `expiresAt`,
   `createdAt`, `updatedAt`.

   **Rejected: exposing a computed `ownable: boolean` instead of the raw
   role.** It is more privacy-minimal, but it breaks this repo's
   established pattern of the UI evaluating *the same pure predicate* the
   server evaluates (`permissions.ts`'s whole reason for existing), and
   it means inventing a new derived field every time a rule grows.
   Exposing `role` to principals who already see every key's id and name
   is a small step by comparison.

4. **`apps/client/app/links/detail/page.tsx:251-254`** — filter the Owner
   dropdown:

   ```tsx
                 options={(keys.data?.data ?? [])
                   // The server refuses a viewer as an owner, so never offer
                   // one — except the current owner, which may already be a
                   // viewer via a demotion and must still render as the truth.
                   .filter((key) => can.ownLink(key) || key.id === link.ownerId)
                   .map((key) => ({ value: key.id, label: key.name }))}
   ```

   The `|| key.id === link.ownerId` clause is not defensive padding: this
   `Picker` wraps Radix `Select` (`apps/client/components/common.tsx:214`),
   and a `value` matching no `SelectItem` renders the placeholder — so a
   viewer-owned link would show a blank Owner field, and a save could
   transfer it silently. (Separately: `ownerId` is `""` for an unowned
   link and Radix refuses `""` as an item value, which
   `common.tsx:210-213` already documents. Pre-existing, out of scope,
   but worth knowing while editing this exact Picker.)

5. **Out of scope, deliberately: `PATCH /keys/:id` demoting a key that
   owns links.** Leave it exactly as it is, and say so here rather than
   by omission, because it is the obvious follow-up question:

   - The invariant being added is "no *new* viewer-owned link", not "no
     viewer-owned link ever". The latter is cross-table, not expressible
     as a constraint, and would need a trigger.
   - Every way of enforcing it on demote is worse than not enforcing it.
     Refusing the demote holds an access *reduction* hostage to data
     cleanup — precisely what `docs/adr/0011` refuses to do for
     revocation. Nulling the owner of N links is silent data loss.
     Reassigning to the demoting admin invents ownership.
   - The resulting state is already safe: `can.editLink` refuses a viewer
     over its own link, so a demoted key loses edit rights on its links
     immediately, which is what the demotion was for. What remains is a
     row whose `owner_id` points at a key that can no longer act on it —
     the same shape as an unowned link, which the model already tolerates
     (`docs/adr/0011`).

   Record it in `can.editLink`'s comment (§1) so it reads as a known
   state rather than a surprise, and add a sentence to `docs/adr/0011`
   noting that a viewer may still hold links via demotion. No new ADR:
   this is a clarification of that one, not a new decision.

   **Superseded by `docs/plans/Plan_26.md` Part B (2026-09-20).** The objection
   above still holds as written — every *naive* way of enforcing "no
   viewer-owned link, ever" on demote is worse than not enforcing it. What
   changes is that the objection gets answered instead of accepted: Plan 26
   adds a bulk reassign endpoint (`POST /keys/:id/links/reassign`) that
   gives the operator a one-call remedy before the refusal ever ships, so
   demotion is never blocked *without* an immediate way through. Revocation
   stays exactly as unconditional as this section and `docs/adr/0011`
   require — the reasoning here is still why that had to be true.

6. **Tests**:
   - `apps/server/test/permissions.test.ts`: `can.ownLink` is false for
     `viewer` and true for `author`/`manager`/`admin`; and
     `can.createLink(actor) === can.ownLink(actor)` across all four roles,
     which locks the §1 delegation so a future edit cannot split them
     again.
   - `apps/server/test/links.test.ts`, beside the existing
     `describe("ownership transfer")` at :244-277: admin transfers to a
     viewer key → 409 with `error.code === "conflict"` and the stored
     `ownerId` unchanged; to an author key → 200 and `ownerName` updates;
     to a random uuid → still 404 `"key not found"` (proves the existence
     check runs first); and an **admin** transferring someone else's link
     to a viewer gets 409 rather than 403 — the assertion that the error
     is about the target, not the caller.
   - `apps/server/test/keys.test.ts`: an author listing keys sees
     `{ id, name, role }` and no `prefix`/`expiresAt`/`createdAt`; an
     admin still sees the full `ApiKey`.

---

## Part B — sorting by created and updated, asc and desc

No schema change, independent of every other part.

1. **`packages/shared/src/links.ts:60`** —
   `sort: z.enum(["createdAt", "updatedAt", "visits"]).default("createdAt")`.
   `order` is untouched: it already exists at :61.

2. **`apps/server/src/http/api/links.ts:175-180`** — replace the
   two-branch ternary with a map, and add a stable tiebreaker:

   ```ts
       // Every sortable column in one place; `visits` is the joined
       // expression rather than a column, which is why this is a map and
       // not a field name.
       const sortable = {
         createdAt: links.createdAt,
         updatedAt: links.updatedAt,
         visits: total,
       } as const
       const direction = q.order === "asc" ? asc : desc
       const rows = await query
         .where(where)
         // `links.id` is a UUIDv7, so the tiebreak is chronological rather
         // than arbitrary — and without it, equal sort keys make paging
         // non-deterministic: a row can appear on two pages or on none.
         .orderBy(direction(sortable[q.sort]), direction(links.id))
         .limit(q.limit)
         .offset(q.offset)
   ```

   **The tiebreaker is in scope, in this commit.** The list has no
   tiebreaker today, which is a latent pagination bug that `createdAt`
   ties rarely trigger — but `updatedAt` ties are easy to produce (any
   two PATCHes in the same millisecond, a bulk archive, a backfill), so
   this change is what makes the bug bite. Shipping a new sort key while
   knowingly leaving its pagination non-deterministic is the wrong trade,
   and the fix is one expression. Tying the tiebreak to `q.order` rather
   than hardcoding `desc` makes `asc` an exact mirror of `desc`, which is
   a property that tests in one line.

3. **No btree indexes on `created_at`/`updated_at`.** Write the threshold
   down so this is not re-litigated:

   - The default page is 25 rows off a table that, for this product's
     shape, holds thousands. A scan-and-sort at that size is
     sub-millisecond, and two more indexes on `links` are paid on every
     insert and every PATCH — and PATCH is already the path that touches
     `updated_at` on every single edit, making a `(updated_at)` index the
     most write-amplifying of the two.
   - One of the three sort keys (`visits`) is a `coalesce` over a left
     join on `visit_counts` and can never be indexed, so a uniformly
     indexed sort is not on offer anyway.
   - Past roughly 50k rows the right move is a plain `(created_at desc)`
     or `(updated_at desc)` index — single-column is enough even with the
     id tiebreak, because incremental sort (PG13+, and this repo already
     requires PG15+ for `NULLS NOT DISTINCT` in `visit_days_key`) sorts
     only within each tie group. Adding it then is a pure `CREATE INDEX`
     migration with no data change. One caveat for whoever does it:
     migrations apply inside a transaction at boot
     (`apps/server/src/db/migrate.ts`), so `CREATE INDEX CONCURRENTLY` is
     not available there — a plain `CREATE INDEX` takes a write lock for
     the build, negligible at these sizes and not at ten million rows.

   This is deliberately the opposite call from Part C §3's
   `links_listed_idx`, and the asymmetry should hold up in review: a tiny
   partial index serving an uncached public endpoint earns its write
   cost; two full-size indexes serving an already-fast authenticated page
   do not.

4. **`apps/client/lib/store/links.ts:5-13`** — `LinkFilters` widens to
   `sort?: "createdAt" | "updatedAt" | "visits"` and gains
   `order?: "asc" | "desc"`. `qs(filters)` already serialises whatever is
   present, so no other change is needed there.

5. **`apps/client/app/links/page.tsx`** — `Filters` gains
   `order: "asc" | "desc"`; `EMPTY` (:37) gains `order: "desc"`. The sort
   labels become plain column names — "Created", "Updated", "Visits" —
   because direction is no longer baked into them ("Newest first" is now
   the order control's job). Keep `lg:grid-cols-5` on the filter card and
   put both controls in the existing fifth cell, since they are one
   logical control:

   ```tsx
   <div className="flex gap-2">
     <Picker
       className="flex-1"
       value={filters.sort}
       onChange={(value) => update({ sort: value as Filters["sort"] })}
       options={[
         { value: "createdAt", label: "Created" },
         { value: "updatedAt", label: "Updated" },
         { value: "visits", label: "Visits" },
       ]}
     />
     <Button
       type="button" variant="outline" size="icon"
       aria-label={filters.order === "desc" ? "Sorted descending" : "Sorted ascending"}
       onClick={() => update({ order: filters.order === "desc" ? "asc" : "desc" })}
     >
       {filters.order === "desc" ? <ArrowDown /> : <ArrowUp />}
     </Button>
   </div>
   ```

   `Picker` already accepts `className` (`common.tsx:220`), so this needs
   no new primitive. Rejected: a second `Picker` offering "Newest
   first"/"Oldest first" — more discoverable, but it needs a sixth grid
   column and its options have to be re-worded per sort key ("Most
   visits" vs "Newest"), which is exactly the coupling this change is
   undoing.

   Also add an "Updated" column to `HEAD` (:42) rendering
   `<When iso={link.updatedAt} />` (`common.tsx:176`). Sorting by a
   column the table does not show produces a reordering the user cannot
   verify, which reads as a bug.

6. **Tests** (`apps/server/test/links.test.ts`, beside the existing list
   filter tests at :307-336):
   - `?sort=updatedAt&order=desc` leads with the link PATCHed last.
   - `?sort=createdAt&order=asc` returns the exact reverse of the same
     query with `&order=desc` — one assertion covering both the direction
     plumbing and the mirrored tiebreak.
   - An unknown `sort` value → 400 from the zod enum.
   - `sort=visits` still orders by total visits — a regression guard on
     the map refactor, since `total` is an expression and not a column.
   - **The tiebreaker regression test**, which fails today: insert three
     links directly with an identical `createdAt`, then page with
     `limit=1` at offsets 0/1/2 and assert the three ids are distinct and
     their concatenation equals the single-page order.

---

## Part C — link expiry

Depends on nothing, but touches the same shared schemas as Part D, so it
goes before it rather than beside it.

1. **`apps/server/src/db/schema.ts`** — on `links`, mirroring
   `apiKeys.expiresAt` at :39:

   ```ts
       /** Past this, the link resolves like an unknown slug. Null never expires. */
       expiresAt: timestamp("expires_at", { withTimezone: true }),
   ```

2. **New migration** `apps/server/drizzle/0014_link_expiry.sql` via
   `bun run db:generate`. Metadata-only (a nullable column), no backfill,
   nothing to hand-append beyond the leading `--` comment naming this
   plan, the way `0013_visit_bot_label.sql:1-2` does.

3. **`apps/server/src/http/redirect.ts` — the cache is the whole
   difficulty, and this is the part to read carefully in review.**

   `findActiveTarget` filters `status = 'active'` **in SQL** (:69), and
   that is correct only because every status change also runs
   `cache.del(targetKey(...))`. Expiry has no such mutation: the change
   is the clock ticking. A link cached at T with `expires_at = T+10s` is
   written as a live target, its row is never touched again, so nothing
   invalidates the entry and it serves a dead link until
   `T + LINQ_CACHE_TTL` (300s by default, `apps/server/src/config.ts:20`).
   Any correct design compares against the clock **on the read**, which
   means the timestamp has to live inside the cached value.

   `ResolvedTarget` (:24-31) gains one field:

   ```ts
     /**
      * Epoch milliseconds, not a Date and not an ISO string: this object is
      * JSON-round-tripped by the Redis backend and stored by reference by
      * the memory one, and a number is the only shape that survives both
      * identically. Null means the link never expires.
      */
     expiresAt: number | null
   ```

   built in `findActiveTarget` as `row.expiresAt?.getTime() ?? null`.
   Verified from `apps/server/src/cache.ts` that the two backends really
   do differ this way — `redisCache` does `JSON.stringify`/`JSON.parse`
   (:117-119) while `memoryCache` stores the object by reference with an
   explicit "No serialisation" comment (:183-184). So a `Date` here would
   be a **Redis-only runtime TypeError** that typechecks fine and passes
   every test, because the test harness defaults to `noCache`/
   `memoryCache`. An ISO string is correct but costs a parse per
   redirect, and a malformed value yields `NaN`, where `NaN <= Date.now()`
   is `false` — it fails *open*, serving an expired link forever. A
   number cannot be corrupted by JSON and compares in one instruction on
   the hot path.

   ```ts
   /**
    * A link past its expiry is a stranger. Checked here rather than in
    * `findActiveTarget`'s WHERE clause because the cached entry outlives
    * the moment it lapses and no mutation ever arrives to invalidate it:
    * `status` is safe in SQL only because every status change also dels
    * `targetKey`. See docs/plans/Plan_25.md.
    */
   function expired(target: ResolvedTarget): boolean {
     return typeof target.expiresAt === "number" && target.expiresAt <= Date.now()
   }
   ```

   `typeof === "number"` rather than `!== null` is deliberate: during a
   rolling restart, a Redis entry written by the *old* build has no
   `expiresAt` key at all, and `undefined !== null` is `true`, which would
   read every pre-deploy cached link as instantly expired. This treats a
   shape-drifted entry as "no expiry" — failing open for at most one TTL.
   `<=` rather than `<` matches `auth/middleware.ts:42` exactly.

   At :158-162, fold an expired target to `null` **before** the `visit`
   object is built, so every step below is untouched — `if (!link)` at
   :178 records `link_id: null`, falls back to `domain.fallbackUrl ?? 404`,
   and routes a preview crawler into `ogPreview(c, host, slug, null)`,
   which titles the card with the host rather than the link's name:

   ```ts
     const cached = slug
       ? await through(c, targetKey(domain.id, slug), () =>
           findActiveTarget(c.var.db, domain.id, slug),
         )
       : null

     // 2b. An expired link is an unknown slug: same orphan path, same null
     //     link_id, same fallback. See `expired` for why this is not a WHERE.
     const isExpired = cached !== null && expired(cached)
     if (isExpired) reqLog().debug({ linkId: cached.linkId, slug }, "link expired")
     const link = isExpired ? null : cached
   ```

   One constraint to state in review: **never mutate the cached object**
   (no `cached.expired = true`), because `memoryCache` hands the same
   reference to every request.

   **Rejected: also filtering expired rows in `findActiveTarget`'s WHERE
   clause.** One place should decide. Two means two clocks — Postgres's
   `now()` on the database host and `Date.now()` on the app host — that
   can disagree across the boundary, and a reader has to check both to
   know the rule. The only thing it would buy is a marginally cheaper
   negative cache entry on a cold miss for an already-expired link, and
   the positive entry serves the orphan path just as cheaply.

   **Rejected: clamping the cache TTL to the remaining lifetime.**
   `Cache.set` has no TTL parameter, so this means touching the `Cache`
   type, both backends, `noCache`, `guarded` and their tests — a far
   larger diff than a three-line predicate. It only *bounds* staleness
   rather than eliminating it; eliminating it means
   `min(TTL, msUntilExpiry)`, which is a second clock-dependent
   computation where a `Math.ceil` instead of `floor` silently buys a full
   extra second of serving a dead link. A link expiring in two seconds
   would get a two-second cache entry, which is a thundering-herd
   generator on a hot link at exactly the wrong moment. And the read-time
   check would still be wanted as the real guarantee, so the clamp is
   pure addition.

   **Rejected: bumping `targetKey` to a versioned prefix** to force a cold
   cache on deploy (which would remove the need for the `typeof` guard).
   During a rolling restart the old and new processes compute *different*
   keys, so a mutation made by one would not invalidate the other's entry
   — trading a 300s fail-open window for a 300s fail-*stale* one, which is
   worse: wrong destinations, not merely a link living past its expiry.

4. **API surface**:
   - `packages/shared/src/links.ts`: the `Link` type gains
     `expiresAt: string | null` (ISO, matching `ApiKey`);
     `linkCreateSchema` gains
     `expiresAt: z.iso.datetime().nullable().optional()` (copying
     `keyCreateSchema` verbatim); `linkPatchSchema`'s `strictObject` gains
     `expiresAt: z.iso.datetime().nullable()`.
   - `apps/server/src/http/api/links.ts`: `toLink` maps
     `expiresAt: link.expiresAt?.toISOString() ?? null`; POST converts
     with `body.expiresAt ? new Date(body.expiresAt) : null`.
   - **The one non-obvious edit:** PATCH's blanket
     `.set({ ...patch, updatedAt: new Date() })` (:238) cannot carry this
     field — `patch.expiresAt` is a string and the column takes a `Date`.
     This is exactly the problem `keys.ts:100-107` already solves by
     spelling the fields out; either do the same, or normalise once before
     the `.set`:

     ```ts
     const values = {
       ...patch,
       ...(patch.expiresAt !== undefined
         ? { expiresAt: patch.expiresAt ? new Date(patch.expiresAt) : null }
         : {}),
       updatedAt: new Date(),
     }
     ```

   **Do not require a future timestamp.** `keyCreateSchema` accepts a past
   one and the only comparison in this codebase happens at read time. A
   schema whose verdict changes between two identical requests a second
   apart is confusing on retry and hostile to fixtures —
   `expiresAt: new Date(Date.now() + 50)` is the cleanest expiry test
   there is, and it is *past* by the time a slow CI asserts on it. It also
   gives a free kill switch: `PATCH {expiresAt: <now>}` turns a link off
   without archiving it. The guard belongs in the UI (`min` on the
   datetime input, plus an "Expired" badge), where it is advice rather
   than a gate.

   **Expired links stay visible in list and get.** An expired link is a
   live row with an owner, visits and a slug that is still reserved, and
   seeing it is the only way to un-expire it.

   **Not a `status` value.** `status` is a two-value enum shared with
   `domains`, and expiry is orthogonal — an archived link can also be
   expired. A separate param on `linkListQuerySchema`:

   ```ts
   expiry: z.enum(["any", "live", "expired"]).default("any"),
   ```

   applied next to the other filters with `isNull`/`gt`/`lte` on
   `links.expiresAt` against a single `new Date()` — the app clock, so the
   list and the redirect agree on what "expired" means. It must reference
   only `links` columns: the `total` count at :182 is
   `select({total: count()}).from(links).where(where)` and joins nothing,
   so a filter touching a joined table would break it.

5. **Client**: an expiry field (`datetime-local`, clearable) in
   `apps/client/app/links/new/page.tsx` beside Tags, and in
   `SettingsCard` (`app/links/detail/page.tsx:106-292`), sending `null`
   when cleared. An "Expired" badge in the list row beside the existing
   Archived badge (`app/links/page.tsx:202`), derived from
   `link.expiresAt`.

6. **Tests**:
   - `apps/server/test/redirect.test.ts`: past `expiresAt` → 302 to the
     domain fallback, and the recorded visit has `linkId === null`,
     `slugRequested` = the slug, `destination` = the fallback. Same on a
     domain with no `fallbackUrl` → 404, and the visit is **still**
     recorded (the current code records before the `if (!destination)` at
     :180-181). Future `expiresAt` → normal 302 with `linkId` set. A
     `Slackbot` UA on an expired link gets the orphan `ogPreview` whose
     `<title>` is the host, not the link's name — proving the null happens
     before the crawler branch.
   - `apps/server/test/cache.test.ts` — **the test that justifies the
     whole design**, run on the real `memoryCache` harness that suite
     already uses: create a link with `expiresAt: new Date(Date.now() + 50)`,
     hit it (warms the entry, gets the destination),
     `await Bun.sleep(60)`, hit again → fallback, second visit has
     `linkId: null`. The row was never touched, so no invalidation ran:
     the only way this passes is if the timestamp rode inside the cached
     value and was compared at read time. Mirror: PATCH `expiresAt` to
     null and hit again → resolves immediately, proving the mutation's
     `del` reaches the right key.
   - `apps/server/test/links.test.ts`: POST with `expiresAt` echoes it as
     ISO; PATCH to `null` clears it; PATCH to a new ISO updates it —
     together guarding the string→Date conversion a blanket spread would
     break. The default list still includes an expired link;
     `?expiry=expired` returns only it; `?expiry=live` excludes it.

---

## Part D — an opt-in `/llms.txt`

Goes after Part C: it excludes expired links, and both parts edit the same
shared schemas.

1. **`apps/server/src/db/schema.ts`** — on `links`:

   ```ts
       /** Opt-in: listed in this domain's public /llms.txt catalogue. Off by
        *  default, because listing publishes a link's slug, name and
        *  destination to anyone. */
       listed: boolean("listed").notNull().default(false),
   ```

   plus, in the index list at :81-86:

   ```ts
       index("links_listed_idx").on(t.domainId).where(sql`${t.listed}`),
   ```

   Named **`listed`**, not `crawlable`: every short link is already
   crawlable in the sense that a crawler can follow it, so that name would
   describe something this column does not control. `listed` states
   exactly what is true — this link appears in the instance's public
   catalogue — and generalises cleanly if a `sitemap.xml` or an HTML index
   ever appears, where `crawlable` would then be describing two different
   surfaces. (`public` is worse still: every link is already publicly
   resolvable.)

   Settable on **create and patch**. The new-link form is exactly where
   someone decides a link is a public marketing link, and forcing
   create-then-patch is two writes for no safety gain, since the flag is
   per-link and reversible. `linkCreateSchema` gains
   `listed: z.boolean().default(false)`; `linkPatchSchema` gains
   `listed: z.boolean()`; `toLink` maps it; the `Link` type gains
   `listed: boolean`.

   The partial index follows the existing `visits_orphan_occurred_idx`
   precedent and is justified where Part B §3's rejected indexes are not:
   it holds only opt-in rows so it is tiny, and it serves an
   unauthenticated public endpoint whose first hit after every mutation is
   a cold cache miss.

2. **New migration** `apps/server/drizzle/0015_link_listed.sql` via
   `bun run db:generate`, carrying the column and the index.

   **Two migrations, not one combined `0014`.** Drizzle's snapshot chain
   is linear, so welding both columns into one file means shipping expiry
   alone would put an unused `listed` column in production, and splitting
   later would mean regenerating the snapshot and journal by hand. Every
   existing migration here is one concept (`0008_link_preset_params`,
   `0013_visit_bot_label`) — the filename is the changelog. The runtime
   cost of splitting is zero: both are metadata-only in PG11+, including
   `boolean not null default false` (the default is stored in the
   catalogue, not backfilled), and both apply in the same boot. The rule
   worth writing down: **one migration per schema-affecting feature**,
   even when two land in the same PR.

3. **New `apps/server/src/http/llms.ts`**, mounted in `app.ts` directly
   after the `robots.txt` line (:84) and before `app.get("/")`:

   ```ts
     app.on(["GET", "HEAD"], "/llms.txt", llmsHandler)
   ```

   `on([...])`, not `.get()`: verified that `HEAD /robots.txt` returns 404
   today, because :84 registers GET only and a HEAD falls through to the
   catch-all at :93, where `RESERVED_SLUGS.has("robots.txt")` 404s it. Do
   not reproduce that bug here; fixing `robots.txt` the same way is a
   one-word drive-by worth taking in the same commit.

   Add `"llms.txt"` to `RESERVED_SLUGS` (`packages/shared/src/primitives.ts:18`)
   for consistency, knowing it is belt-and-braces rather than the
   mechanism: `SLUG_PATTERN` (:20) has no `.`, so `slugSchema` could never
   have produced that name anyway, and the catch-all's first-segment guard
   is unreachable once the route above is mounted.

   `robots.txt` itself needs no new directive — it disallows `/api` and
   `/home` only, so `/llms.txt` is already allowed, and there is no
   standard robots directive pointing at an llms.txt.

   **No auth, by design.** The route sits outside `/api/v1`, so
   `authenticate` never runs — which is the entire point, and also the
   reason `listed` defaults to false.

4. **Shape: a pure renderer plus a thin handler**, so that escaping,
   capping, ordering and the empty case are unit-testable without a
   database or a request:

   ```ts
   export type LlmsEntry = { name: string; url: string; destination: string }

   /** Renders the llms.txt document. Pure, so escaping, capping and ordering
    *  are testable without a database or a request. */
   export function renderLlms(host: string, entries: LlmsEntry[], truncated: boolean): string
   ```

   The document follows the llms.txt markdown convention — H1, a
   blockquote summary, H2 sections, `- [name](url): description` bullets:

   ```
   # links.example.com

   > Short links published on links.example.com. Each entry is a redirect;
   > the URL after the colon is where it leads.

   ## Links

   - [Q3 investor update](https://links.example.com/q3): https://example.com/reports/q3-2025
   ```

   - The markdown target is `shortUrl(host, slug)`
     (`api/links.ts:37`, already imported across module boundaries by
     `redirect.ts:14`), **not** the destination. The short URL is what
     this domain owns, what stays stable when the destination changes, and
     what records a visit when followed — so a crawler that follows it
     lands in `visits` with `is_bot = true` and a `bot_label` from
     Plan 24's work. The feature measures itself with no extra code.
   - Name is `link.name ?? link.slug`, so it is never empty.
   - Description is the destination URL: the single most useful fact for
     deciding whether to follow, it needs no new column, and it is already
     public to anyone who follows the redirect once. Omitting the
     `: description` half is spec-legal if that leak is ever judged too
     much, but the document then becomes a list of opaque short links,
     which is close to useless to an LLM.
   - **No `description` column in v1.** `name` is already the human label —
     it is what `ogPreview` uses for `og:title` — and a second free-text
     field immediately raises "which one does the preview card use?". If
     prose is wanted later, add `description text` falling back to
     `destination`: additive, no migration risk.
   - **One flat `## Links` section, not one per tag.** Tags are freeform
     and multi-valued, so grouping forces arbitrary decisions the spec does
     not require (first tag? every tag, duplicating links? an "Other"
     bucket?). Keep it flat until someone asks.
   - Escaping: the markdown *target* is provably safe without escaping —
     `SLUG_PATTERN` excludes `(`, `)` and whitespace, and the scheme and
     host come from `hostSchema` — so only `name` and `destination` need a
     helper: collapse whitespace to a single space, trim, and escape `[`
     and `]`. A destination sits in text position where parentheses are
     harmless, and a URL cannot contain a raw newline, so one helper
     covers both.
   - `content-type: text/markdown; charset=utf-8` — `c.text()` would send
     `text/plain`, so use `c.body(md, 200, {...})`.
   - `cache-control: public, max-age=${c.var.config.LINQ_CACHE_TTL}`.
     Unlike the redirect's `no-store` (`redirect.ts:221`), this response
     *should* be cacheable by crawlers and CDNs, and matching the
     server-side entry's lifetime means the two windows cannot disagree.

5. **Host resolution** reuses the redirect's, exactly:

   ```ts
     const host = c.req.header("host") ?? new URL(c.req.url).host
     const domain = await through(c, domainKey(host), () => findActiveDomain(c.var.db, host))
     if (!domain) return c.text("Not Found", 404)
   ```

   This needs `through` and `findActiveDomain` exported from
   `redirect.ts`, which already exports `ResolvedDomain`, `mergeQuery` and
   `queryMap`, so exporting is in keeping. Rejected: extracting a
   `http/host.ts` module — it would move `through`, a hot-path generic,
   for no behavioural gain, turning a feature into a refactor. The small
   win of reusing it: `/llms.txt` reads the *same* `domainKey` entry the
   redirect warms, so it costs zero extra queries on a live instance.

   Unknown or archived host → `c.text("Not Found", 404)`, identical to
   the redirect's step 2 and deliberately not the JSON `ApiError` shape:
   this is a public text surface, not the API.

   A known host with **zero listed links → 200** with the H1, the
   blockquote, the `## Links` heading and no bullets. A 404 would be a lie
   (the domain exists) and invites crawler retries; an empty catalogue is
   the honest, trivially parseable answer.

6. **The query, ordering and cap**:

   ```ts
     .where(and(
       eq(links.domainId, domain.id),
       eq(links.status, "active"),
       eq(links.listed, true),
       or(isNull(links.expiresAt), gt(links.expiresAt, new Date())),
     ))
     .orderBy(asc(sql`coalesce(${links.name}, ${links.slug})`), asc(links.id))
     .limit(MAX_LISTED + 1)
   ```

   - Archived excluded by `status = 'active'` — the same rule the redirect
     applies, since listing a link that does not resolve would publish a
     URL that lands on the fallback.
   - Expired excluded by the timestamp predicate, app clock, matching
     Part C §4's list filter.
   - **Alphabetical by display name, tiebroken by id.** A catalogue is not
     a feed: alphabetical means the file changes only when its *contents*
     change, so it stays diff-friendly and a crawler's conditional fetch
     remains meaningful. `created_at desc` would reshuffle the top every
     time anyone adds a link. The sort is unindexable, but with at most
     501 rows for one domain that is noise.
   - `const MAX_LISTED = 500`, a module constant rather than config — one
     fewer knob, and no llms.txt is improved by 50,000 entries. The reason
     to cap at all: this is an unauthenticated endpoint whose response is
     built in memory, so uncapped, an instance with 200k listed links
     renders a multi-megabyte body on every cold entry — a latency cliff
     and a cheap amplification target. `limit(MAX_LISTED + 1)` reports
     truncation without a second `count()` query; when truncated, append a
     final italic line saying only the first 500 are shown.

7. **Server-side caching: cache the rendered string**, keyed by domain id.
   A string has no `Date` problem — Part C's lesson applied in reverse.

   ```ts
   /** The whole rendered /llms.txt for one domain. A string round-trips
    *  through both backends unchanged, so unlike a row array it needs no
    *  date handling. */
   export const llmsKey = (domainId: string): string => `linq:llms:${domainId}`

   /** Everything a link mutation makes stale: its redirect entry and its
    *  domain's published catalogue. One call, so a new mutation cannot
    *  forget half of it. */
   export const linkKeys = (domainId: string, slug: string) => [
     targetKey(domainId, slug),
     llmsKey(domainId),
   ]
   ```

   Use `await c.var.cache.del(...linkKeys(...))` at all four existing
   `cache.del` sites in `api/links.ts` (:214, :240, :254, :278) rather
   than adding a second `del` call to each and hoping the fifth mutation
   remembers. `Cache.del` is already variadic and `redisCache` already
   guards `if (keys.length)`. `domainId` is immutable on a link, so
   `existing.domainId` is always the right catalogue to clear.

   **The staleness window being accepted, stated in the comment:** a link
   whose expiry passes with no accompanying mutation stays listed for up
   to one TTL. That is fine, and the reason is the point — the *redirect*
   is still exact, treating the expired link as an orphan the instant it
   lapses, so the worst case is a crawler following a listed link and
   landing on the domain fallback. Making the listing exact would mean
   caching rows plus `expiresAt` and re-doing the epoch-ms dance for a
   cosmetic gain.

8. **Client**: a "List in llms.txt" switch beside the `forwardQuery`
   control in both `app/links/new/page.tsx` and `SettingsCard`, with a
   hint naming what publishing means ("Publishes this link's name and
   destination at /llms.txt, readable without a key").

9. **New ADR** `docs/adr/0013-short-links-are-published-only-by-opt-in.md`
   — this one meets the `linq-adr` bar: a new public, unauthenticated
   surface and a privacy boundary. The decision is opt-in per link
   defaulting to false; the rejected alternative is listing every active
   link with an opt-*out*; the reason is that a short link's destination
   is frequently the interesting secret and a default that publishes it is
   unrecoverable once crawled. One line for the future: `llms-full.txt`
   (the full-content sibling convention) is explicitly out of scope — linq
   owns redirects, not the content behind them.

   No ADR for Parts A–C: the expiry-vs-cache reasoning is a design detail
   belonging in this plan and in `expired()`'s comment, and the viewer
   rule is a clarification of `docs/adr/0011` (Part A §5).

10. **Tests**, in a new `apps/server/test/llms.test.ts`:
    - Unit, against `renderLlms` directly: a name containing `]` and a
      newline collapses to one escaped line; the `name ?? slug` fallback;
      the truncation note; the empty-catalogue document.
    - Integration, through the harness: unknown host → 404; **no key →
      200** (the harness's `request` without a key is the whole
      assertion); `content-type` starts with `text/markdown`; a listed
      active link renders as `- [Name](https://host/slug): https://dest`,
      and the body contains the *short* URL, not merely the destination; a
      link created without `listed` does **not** appear, which is the
      security property this whole part rests on; an archived listed link
      and an expired listed link do not appear.
    - Invalidation, on the `memoryCache` harness: GET `/llms.txt`, create
      a second listed link through the API, GET again → the second link is
      present. This is the test that catches a forgotten `llmsKey` del,
      and it is why §7's `linkKeys` helper exists.

---

## Docs that mirror the schema and the API

- `resources/dbml/linq.dbml` — `Table links` (:81-106) gains `expires_at`
  and `listed` with notes, plus `links_listed_idx` in the `Indexes` block.
- `resources/openapi/linq.openapi.json` — the `Link` schema gains
  `expiresAt` (nullable date-time) and `listed`; the create and patch
  bodies gain both; `GET /links` adds `updatedAt` to the `sort` enum
  (~:488) and the new `expiry` param; the keys list summary gains `role`;
  `PATCH /links/{id}` gains a 409 response; and `/llms.txt` is worth
  documenting as a path beside the existing `/robots.txt` entry
  (:1295-1307) even though it lives outside `/api`. That entry's current
  wording — "short links themselves are crawlable" — should be updated to
  point at the new catalogue.

## Sequencing

A → B → C → D. A and B are genuinely independent of everything and of each
other, so either can go first or they can go in parallel; neither touches
the schema. C and D both edit `linkCreateSchema`, `linkPatchSchema`,
`toLink`, the `Link` type and the same two client forms, so running them
in parallel is a guaranteed conflict for no gain — same person,
sequentially, C first because D's query excludes expired links. Within
each part, code before its migration and tests, as in every prior plan
here.

## Verification

```
bun run db:generate   # once for Part C, again for Part D
bun test apps/server/test/links.test.ts apps/server/test/redirect.test.ts \
         apps/server/test/cache.test.ts apps/server/test/permissions.test.ts \
         apps/server/test/keys.test.ts apps/server/test/llms.test.ts
bun run test
bun run typecheck
```

Manual, against the local stack (see `.claude/skills/linq-dev`), mirroring
how Plans 20–24 were each verified live:

1. Create a link expiring ~30s out, follow it (redirects), wait past it,
   follow again → domain fallback, or 404 on a domain with none. Confirm
   the link is still listed in the UI and that the second hit shows up as
   an orphan visit on the domain, not on the link. Confirm the same on a
   `LINQ_REDIS_URL` stack, since the memory backend cannot exercise the
   JSON round-trip that dictated the epoch-ms choice.
2. `curl -sS http://localhost:3000/llms.txt` with **no key** → markdown
   listing only the links switched on. Toggle `listed` in the UI, re-curl
   → the catalogue reflects it on the next request rather than after the
   TTL. Confirm an archived and an expired listed link are both absent.
3. As an admin, open a link's Settings → viewer keys are absent from the
   Owner dropdown; `curl -X PATCH .../api/v1/links/:id -d '{"ownerId":"<viewer key>"}'`
   → 409 with a message naming the target, not the caller.
4. On the links list, switch Sort to Updated and flip the order toggle;
   edit a link and confirm it jumps to the top under Updated/descending.

## Risks

- **The expiry-in-cache path is the one place a bug would be invisible in
  review.** A `Date` in `ResolvedTarget` typechecks and passes every
  memory-backed test while failing only on Redis; an ISO string fails
  open. The epoch-ms decision and the `cache.test.ts` test in Part C §6
  are what make it reviewable — neither is optional.
- **`/llms.txt` is the first unauthenticated surface that reads link
  rows.** The default-false column is the whole safety property, so the
  "a link created without `listed` does not appear" test is the one that
  must never be deleted.
- Part A widens what a non-admin sees about other keys (`role`). Judged a
  small step for principals who already see every key's id and name, but
  it is a real widening and is called out here rather than buried in the
  diff.
- Part B's tiebreaker changes the order of results for existing callers
  where sort keys tie — strictly an improvement (today those cases are
  non-deterministic), but it is an observable change to a shipped API.
- No backfill anywhere: `expires_at` is null and `listed` is false for
  every existing link, which is the intended state for both. Same
  forward-only stance every prior plan here has taken.
