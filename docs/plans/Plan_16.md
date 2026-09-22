# linq — Plan 16: preset params on a link

Follows `docs/plans/Plan_15.md`.

## Context

A Link can forward the caller's query string to its Destination, and that is
the only control it has over the outgoing query. There is no way to say "every
visit to this link should arrive with `utm_source=qr`" — the only workaround is
to bake the parameter into the Destination URL itself, where forwarding then
overwrites it the moment a caller sends the same key.

That last part is the crux. `mergeQuery` (`apps/server/src/http/redirect.ts:104-109`)
deletes every incoming key from the Destination and re-appends the caller's
values, so today the precedence is **destination loses to the caller,
unconditionally**:

```ts
export function mergeQuery(destination: string, incoming: URLSearchParams): string {
  const url = new URL(destination)
  for (const key of new Set(incoming.keys())) url.searchParams.delete(key)
  for (const [key, value] of incoming) url.searchParams.append(key, value)
  return url.toString()
}
```

So a parameter baked into the Destination is not a setting, it is a default the
caller can quietly override. What is wanted is the opposite: a set of key/value
pairs on the Link that win over both the Destination's own query and anything
forwarded.

The useful discovery is that `mergeQuery` **already is** that operation. Its
contract is "these params win per key" — it is only ever called with the
incoming query, but nothing in it is specific to the caller. Applying preset
params is the same function with a different source, so this feature needs no
new merge logic at all, only a second call. Verified against the real function:

| step | result |
|---|---|
| destination | `https://e.test/p?a=dest&b=dest&keep=dest#frag` |
| + incoming `a=in&c=in` | `…?b=dest&keep=dest&a=in&c=in#frag` |
| + presets `{a,b}` | `…?keep=dest&c=in&a=preset&b=preset#frag` |
| empty presets | unchanged, byte for byte, fragment included |

**`forwardQuery` gates all of it.** It is the Link's switch for whether its
outgoing query may be touched at all, and preset params sit inside that switch
rather than beside it. With forwarding off the Destination is passed through
exactly as written — no caller params, no presets, no re-serialisation. A link
that has opted out of query rewriting has opted out of all of it.

## Decisions

- **Preset Params live on the Link, not on a Rule.** They apply to whichever
  Destination wins, default or a Rule's. A Rule that wants different parameters
  can put them in its own Destination URL, where the presets will still override
  a collision — the same relationship the default Destination has.
- **They apply only when `forwardQuery` is on.** `forwardQuery` is the master
  switch for modifying the outgoing query; presets are the second, narrower step
  inside it. Off means untouched, and untouched means untouched.
- **One value per key**, so the wire shape is a JSON object rather than a list
  of pairs. A repeated key is impossible by construction, and a Destination or
  incoming query that repeats a key collapses to the single preset value.
- **"Preset Param", `presetParams`.** Deliberately not "query param": the
  Condition type `query_param` already means *a predicate on the incoming
  query*, and this is the opposite direction — it writes the outgoing one.
- **`mergeQuery` is reused, with its parameter renamed** `incoming` →
  `overrides`. The function is unchanged; the rename is because it is about to
  have two callers and only one of them is the caller's query. Its doc comment
  moves from "incoming parameters win" to "these win".
- **The column is `jsonb NOT NULL DEFAULT '{}'`**, following `links.tags`
  (`not null`, `default '{}'`) rather than `visits.query` (nullable). No null
  branch anywhere, and the emptiness check is `Object.keys(...).length`.
- **Presets are accepted on a link with forwarding off**, not rejected. Refusing
  them would make the two fields order-dependent to edit. They are stored,
  returned, and inert until forwarding is switched on — and the UI says so,
  because a setting that silently does nothing is the trap this plan should not
  ship. See §5 and the last Risk.

---

## 1. Shared schema — `packages/shared/src/links.ts`

There is no existing param validator to reuse; the closest precedent is the
`query_param` Condition's key/value sizing (`packages/shared/src/rules.ts:12-14`),
which this deliberately matches so the two read alike:

```ts
/**
 * Set on the destination at redirect time, overriding both the destination's
 * own query and anything forwarded. Applied only when the link forwards; one
 * value per key, so a repeated key is impossible by construction.
 */
export const presetParamsSchema = z
  .record(z.string().trim().min(1).max(64), z.string().max(512))
  .refine((p) => Object.keys(p).length <= 20, "at most 20 preset params")
```

Confirmed against the installed zod 4.1.13: `z.record(key, value)` does enforce
the key schema (empty and over-long keys are rejected), an empty **value** is
allowed — `?flag=` is a legitimate thing to set — and a `.refine` on key count
works.

- `linkCreateSchema` (line 5, a plain `z.object`) gains
  `presetParams: presetParamsSchema.default({})`. `LinkCreate` is `z.input`, so
  it stays optional for callers.
- `linkPatchSchema` (line 20) gains `presetParams: presetParamsSchema`. **This
  one matters**: the schema is a `strictObject`, so without this line a PATCH
  carrying the field is a 400. Sending `{}` is how a link's presets are cleared;
  there is no separate delete.
- The hand-written `Link` response type (line 52) gains
  `presetParams: Record<string, string>`.

## 2. The column — migration `0008`

`apps/server/src/db/schema.ts`, in `links` beside `forwardQuery` (line 80):

```ts
presetParams: jsonb("preset_params")
  .$type<Record<string, string>>()
  .notNull()
  .default({}),
```

Then `bun run db:generate --name link_preset_params`. Unlike `0006` and `0007`,
**the generated SQL should be correct as-is** — this is a plain `ADD COLUMN`
with a default, not an enum or a rename, so drizzle has nothing to get wrong.
Read it before keeping it; it should be one statement of the shape
`ALTER TABLE "links" ADD COLUMN "preset_params" jsonb DEFAULT '{}'::jsonb NOT NULL;`.
Existing rows take the default, so there is no backfill and no data migration.

## 3. The redirect — `apps/server/src/http/redirect.ts`

Three edits, all small.

**`mergeQuery` (104-109)** — rename the parameter and generalise the comment.
The body does not change:

```ts
/**
 * The given parameters win per key, and repeats survive: every key in
 * `overrides` replaces the destination's copy of that key entirely.
 */
export function mergeQuery(destination: string, overrides: URLSearchParams): string {
```

**`ResolvedTarget` (23-28)** — this is the shape cached under `targetKey`, so
the presets must ride inside it or a cache hit would serve a link without them:

```ts
export type ResolvedTarget = {
  linkId: string
  destination: string
  forwardQuery: boolean
  presetParams: Record<string, string>
  rules: { destination: string; conditions: Condition[] }[]
}
```

`findActiveTarget` selects with a bare `.select()`, so the column arrives on
`row` automatically; only the projection at 72-77 needs `presetParams: row.presetParams`.

**The application point (line 182)**, plus one small helper beside `mergeQuery`:

```ts
/** Preset params win over everything already on the URL. None leaves it untouched. */
function applyPresets(destination: string, presets: Record<string, string>): string {
  return Object.keys(presets).length
    ? mergeQuery(destination, new URLSearchParams(presets))
    : destination
}
```

```ts
  // 6. `forwardQuery` is the link's switch for touching the outgoing query at
  //    all: off passes the destination through exactly as written, presets
  //    included. On, the incoming query merges in first and the link's own
  //    preset params then overwrite whatever is there — the destination's query
  //    and the forwarded one alike.
  const destination = link.forwardQuery
    ? applyPresets(mergeQuery(chosen, url.searchParams), link.presetParams)
    : chosen
```

`new URLSearchParams(record)` takes a `Record<string, string>` directly, which
is why the map shape costs no conversion code. The emptiness guard inside
`applyPresets` is not just an optimisation: without it a link with no presets
would have its query re-serialised for nothing, which is observable (spaces
become `+`, key order shifts).

Note this sits **after** the rule has chosen `chosen`, so presets apply to a
Rule's destination exactly as they do to the default one.

## 4. The API — `apps/server/src/http/api/links.ts`

`toLink` (41-63) gains `presetParams: row.presetParams`. Nothing else: the POST
handler spreads its validated body into the insert, and the PATCH handler does a
blanket `.set({ ...patch, updatedAt: new Date() })` (234-237), so a field added
to both schemas is already carried. The existing `cache.del(targetKey(...))` at
line 238 already invalidates on edit.

## 5. The client

A new `apps/client/components/preset-params-editor.tsx`, modelled on
`ConditionRow` (`apps/client/components/rules-editor.tsx:227-292`) — the only
existing key/value row in the codebase. Same idiom: a `flex flex-wrap
items-center gap-2` row, two `w-40` `Input`s, a ghost **Remove** at the end, and
an **+ Add parameter** `Button` below. `readOnly`/`disabled` follows the rules
editor's split: controls that add or remove disappear, value inputs stay mounted
and take `disabled`.

**The one real design point: the editor's state is a list, the wire shape is a
map.** Editing a `Record` directly is not viable — renaming a key character by
character would collide with existing keys and lose input focus. So the
component holds `Array<{ key: string; value: string }>`, seeded from
`Object.entries(presetParams)`, and converts on the way out:

- rows with a blank key are dropped,
- on a duplicate key the last row wins, matching what the object would do anyway.

**It must say when it is inert.** The component takes the current `forwardQuery`
draft value, and when that is off it renders a one-line hint — *"Not applied
while this link does not forward the query."* — beside the rows. The rows stay
editable, so the two fields can be set in either order. This is the whole reason
presets are accepted rather than rejected in that state, and without the hint the
combination is exactly the kind of silently-dead setting this codebase has
otherwise avoided.

Wire it into both forms, as a `Field` child beside Tags:

- `apps/client/app/links/new/page.tsx` — a `useState<Array<{key,value}>>([])`
  alongside the existing per-field state, converted into the `createLink` payload
  at 47-64.
- `apps/client/app/links/detail/page.tsx` `SettingsCard` — seeded from
  `link.presetParams` at 117-122, included in the PATCH body at 124-143, and
  `disabled={!canEdit}` like every other control there.

Both forms already hold `forwardQuery` in local state, so the hint tracks the
unsaved checkbox rather than the persisted value.

No change to `apps/client/lib/store/links.ts`: both mutations are already typed
`LinkCreate` / `LinkPatch`, so the field arrives with the schema.

## 6. Generated artifacts and docs

- `resources/openapi/linq.openapi.json` — add `presetParams` to `Link` (1834-1927,
  including its `required` list), `LinkCreate` (1928-1965, with `"default": {}`)
  and `LinkPatch` (1966-2002). House style: `additionalProperties` typed as a
  string with `maxLength: 512`, `maxProperties: 20`, and a one-sentence
  `description` stating the *behaviour* — that it overrides the destination's own
  query and anything forwarded, and applies only when `forwardQuery` is true. The
  `forwardQuery` description at 1893-1896 should say it gates presets too.
- `resources/dbml/linq.dbml` — a `preset_params` row in `Table links` (95-121),
  following the `rules.conditions` note style, which names the TypeScript type
  and the bounds: `jsonb [not null, default: `'{}'::jsonb`, note: 'Record<string,string>: set on the destination when forward_query is true, overriding its own query and the forwarded one. At most 20.']`
- `CONTEXT.md` — a new glossary term after **Destination**:

  > **Preset Param**: a key and value set on the Destination at redirect time,
  > overriding the Destination's own query and any forwarded query on collision.
  > Applied only when the Link forwards its query.

  No ADR. This is a feature within the existing redirect design, not a reversal
  of a recorded decision.

## 7. Tests

**`apps/server/test/redirect.test.ts`** is where the behaviour lives. Five cases:

1. a preset overrides a forwarded param of the same key,
2. a preset overrides the destination's own param,
3. **`forwardQuery: false` leaves the destination untouched even with presets
   set** — the case this plan exists to get right. It belongs directly beside the
   existing test at 224-234, which already pins the no-presets half of it.
4. a link with no presets produces a byte-identical URL, fragment included,
5. presets apply to a **rule's** destination, not just the default one.

**`apps/server/test/links.test.ts`** — extend the default-shape assertion at
32-38 with `presetParams: {}`; a PATCH that sets presets and one that clears them
with `{}`; and validation 400s for an empty key, an over-long value, and more
than 20 keys. `h.createLink`'s body is an untyped `Record<string, unknown>`
spread over defaults, so the helper needs no change.

**No client tests.** `apps/client/test/` contains only `servers.test.ts`; there
is no component test surface to extend, and this plan does not add one.

## Sequencing

1. **§1**, the shared schema — the field's definition, and what the rest follows
   from.
2. **§2**, column and migration.
3. **§3** and **§4**, the redirect and the serializer.
4. **§7** server tests, then `bun test`.
5. **§5**, the client.
6. **§6**, artifacts and docs.

## Verification

1. `bun run typecheck`, `bunx biome check .`, `bun test`.
2. Read the generated `0008` SQL before trusting it, then confirm the suite is
   green — it runs every migration against PGlite from scratch.
3. End to end, which is the only way to see the precedence in one place. Create a
   link with `destination: "https://e.test/p?a=dest&keep=dest"`,
   `presetParams: {"a":"preset","utm_source":"qr"}`, `forwardQuery: true`, then
   `curl -i "http://localhost:3000/<slug>?a=caller&c=caller"`. The `location`
   header must carry `a=preset` — not `dest`, not `caller` — plus
   `utm_source=qr`, `keep=dest` and `c=caller`.
4. **Flip `forwardQuery` to `false` on that same link, presets still set, and
   repeat.** The `location` must be exactly `https://e.test/p?a=dest&keep=dest` —
   character for character, with no preset, no caller param and no re-ordering.
   This is the requirement that prompted the plan, so it is worth checking by eye
   rather than only in a test.
5. `PATCH { "presetParams": {} }` and confirm the redirect returns to the bare
   destination — and that the change takes effect immediately, which is what
   proves the cached `ResolvedTarget` was invalidated.
6. In the UI: add two parameters on the create form, save, reopen the link and
   confirm they round-trip; untick **Forward query** and confirm the inert hint
   appears; remove one parameter and save; confirm every control is disabled for
   a viewer.

## Risks

- **A preset beats a parameter the caller deliberately sent.** That is the
  requested behaviour and the entire point, but it is a footgun on links whose
  callers pass something meaningful — a `redirect_uri`, a token, a tracking id.
  Nothing warns the person configuring it, and the collision is invisible at
  redirect time.
- **Applying presets re-serialises the query string.** `URLSearchParams` rules
  are not byte-preserving: a space becomes `+`, and colliding keys move to the
  end. A destination carrying a signed or order-sensitive query can be broken by
  adding an unrelated preset. This is already true of `forwardQuery` today, so it
  is not a new class of problem, and gating presets behind that same switch keeps
  it from reaching any link that has opted out.
- **One value per key cannot express `?tag=a&tag=b`.** A destination that
  repeats a key has every copy collapsed to the single preset value. Moving to a
  list of pairs later would be a wire-format change to a field that is by then in
  use.
- **The editor's list-to-map conversion silently drops rows.** A blank key
  disappears and a duplicate key loses to the row below it, with no message.
  That is the honest behaviour for a map, but someone who types two rows with the
  same key will see one of them vanish on reload.
- **Presets on a non-forwarding link are stored but dead.** The API accepts and
  returns them, and nothing but the UI hint tells anyone they are doing nothing —
  an API-only client sees a configured field with no effect and no error. The
  alternative, rejecting the combination, was rejected itself because it makes
  the two fields order-dependent to edit; this is the cost of that choice.
- **JSON object key order is not fully preserved.** Keys that look like
  integers are reordered by the JavaScript engine, so `{"2":"b","1":"a"}` comes
  back with `1` first, and the resulting query string order follows. Harmless for
  parameter *values*, surprising if anyone reads order as meaningful.
