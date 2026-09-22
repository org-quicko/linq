# linq — Plan 22: a visit's recorded destination shouldn't include the forwarded query

Follows `docs/plans/Plan_21.md`.

## Context

Confirmed bug, not intended behavior. `apps/server/src/http/redirect.ts:200–205`:

```ts
const destination = link.forwardQuery
  ? applyPresets(mergeQuery(chosen, url.searchParams), link.presetParams)
  : chosen
...
if (tracked) recordVisit(c.var.db, { ...visit, linkId: link.linkId, destination })
return isPreviewCrawler(userAgent) ? ogPreview(c, host, slug, link) : sendRedirect(c, destination)
```

The *same* fully-merged URL is both the redirect target and what gets
recorded on the visit. `forwardQuery` defaults to `true` on every link
(`links.forwardQuery`, schema default), so for the large majority of links,
whatever query string a particular click happened to carry — a `utm_source`,
a click id, an ad platform's tracking param, literally anything the visitor's
browser sent — gets merged into `chosen` and stored as *that visit's*
`destination`. Two clicks on the exact same link, differing only in an
incoming `?utm_source=`, are recorded as two different destinations.

That's the skew: the `destination` rollup dimension (`visit_days`, dimension
`'destination'`) and the Traffic chart's "group by Destination" both key on
this value, so instead of one bucket per actual configured target, traffic
fragments into one bucket per distinct querystring a link happened to be
clicked with — for a link shared across a few channels with different
tracking params, this can turn one real destination into dozens of
near-empty buckets.

`CONTEXT.md` already says what should have been recorded instead:

> **Visit**: one request to a Domain. Flagged human or bot. Carries platform,
> referer, user agent, **forwarded query**, and **the Destination chosen**.

Two separate facts — "the Destination chosen" (`chosen` in the code: the
link's own destination, or the winning rule's) and "forwarded query" (already
its own field, `visits.query`, populated from the *visitor's own* incoming
`URLSearchParams` before any merging). The implementation conflates them by
baking the query into `destination` instead of keeping them apart, which is
exactly backwards from what's documented and exactly what produces the skew.

**The redirect itself is correct and unaffected.** The 302 a browser
receives must keep carrying the merged query — that's the whole point of
`forwardQuery`/preset params, and no part of this plan touches it. Only what
gets *recorded* changes.

**Fix has no schema or migration footprint.** `visits.destination` and the
`visit_days` rollup trigger already just store/aggregate whatever string the
app hands them — this is a one-function code fix in `redirect.ts`, nothing
else needs to change to benefit from it.

## 1. `apps/server/src/http/redirect.ts`

Rename the merged value so it's unambiguous which one is which, and record
`chosen` — the actual Destination — instead:

```ts
// 6. `forwardQuery` is the link's switch for touching the outgoing query at
//    all: off passes the destination through exactly as written, presets
//    included. On, the incoming query merges in first and the link's own
//    preset params then overwrite whatever is there — the destination's query
//    and the forwarded one alike. This only ever affects where the browser is
//    sent, never what gets recorded: the visit's own `query` field already
//    carries whatever the caller sent, so baking it into `destination` too
//    would double-count it and fragment one real destination into one bucket
//    per distinct querystring. See docs/plans/Plan_22.md.
const sendTo = link.forwardQuery
  ? applyPresets(mergeQuery(chosen, url.searchParams), link.presetParams)
  : chosen

// 8. Insert after the response is built, and never await it. Recorded as
//    `chosen` — the Destination the link or rule actually names — not
//    `sendTo`, which is a different, effectively unique string per click.
if (tracked) recordVisit(c.var.db, { ...visit, linkId: link.linkId, destination: chosen })

return isPreviewCrawler(userAgent) ? ogPreview(c, host, slug, link) : sendRedirect(c, sendTo)
```

No other line in the handler changes — `sendTo` is the same value `destination`
already was, just under a name that says what it's for.

## 2. New test — `apps/server/test/redirect.test.ts`

Add to `describe("query forwarding", ...)`, next to `"incoming parameters are
merged over the destination and win"` (line ~200):

```ts
test("the recorded destination is the link's own, never the merged one", async () => {
  await h.createLink(author.key, domain, {
    slug: "recorded",
    destination: "https://example.com/?a=1",
    presetParams: { utm_source: "qr" },
  })

  await get("/recorded?ref=newsletter")
  expect((await lastVisit()).destination).toBe("https://example.com/?a=1")

  await get("/recorded?ref=email&utm_source=override")
  expect((await lastVisit()).destination).toBe("https://example.com/?a=1")
})
```

Two requests with different incoming query strings must record the exact
same `destination`, proving the fragmentation is gone. The redirect target
itself (already covered by the existing tests in this `describe` block) is
untouched by this plan and needs no new assertions.

## What's deliberately not done

- **No backfill.** Every visit already recorded before this fix has the old,
  query-fragmented value baked into `visits.destination` (and summed into the
  `visit_days` `'destination'` rollup under that fragmented key). There's no
  reliable way to recover `chosen` from it after the fact — a merged URL
  doesn't say which of its query params came from the link's own destination
  versus the caller's request versus a preset, so nothing here can be
  un-mixed. Historical Destination-grouped charts stay skewed for whatever
  window they cover; only a visit recorded after this fix ships is correctly
  attributed. Same call this repo already made in `0011`/`0012` for
  `os`/`browser`, and in `0010` for purge semantics — forward-only, no
  invented recovery of what's already gone.
- **`visits.query` is untouched.** It already exists for exactly the purpose
  of recording what a caller's request carried; this plan doesn't duplicate
  or change it.

## A visible side effect worth confirming

`apps/client/components/visits-card.tsx`'s "Sent to" column reads
`visit.destination` per row. After this fix, every visit to the same link
(or the same matched rule) shows the *same* "Sent to" value — the
link/rule's own Destination — rather than each row's fully-resolved,
query-and-preset-merged URL. The exact URL a given visitor's browser landed
on is still fully reconstructable (`destination` + that row's own `query` +
the link's `presetParams`, visible on the link's detail page), just no
longer collapsed into one string per row. No client change is proposed here
since nothing was asked for beyond the accuracy fix — flagging this so it's
a deliberate tradeoff, not a surprise, once this ships. If a literal
per-row resolved URL is still wanted somewhere, that's an additive column
change, not part of this fix.

## Sequencing

Single change (§1), plus its test (§2). Nothing else depends on it or blocks
it.

## Verification

```
bun test apps/server/test/redirect.test.ts
bun run test
bun run typecheck
```

Manual: click the same short link a few times with different `?utm_...`
query strings, then check the Traffic chart with `groupBy=destination` — it
should now show one bucket for that link's real destination instead of one
per query variant.

## Risks

- Behavior change to already-stored analytics interpretation, not to any
  redirect a visitor experiences — the 302 target is byte-identical to
  before.
- The Log's "Sent to" column becomes less specific per-row, as described
  above — a deliberate, documented tradeoff for correct aggregation, not an
  accidental loss.
- Pre-existing failures already noted in `docs/plans/Plan_20.md`
  (`bootstrap.test.ts`, two in `redirect.test.ts`) are untouched by this plan
  and will still show up in a full `bun run test` run.
