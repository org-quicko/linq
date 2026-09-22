# 0011 – The API key is the principal

**Status**: accepted · 2026-09-17

Extends [0006](./0006-the-admin-ui-is-a-client-not-a-page.md), which already said a key is the only credential linq issues. This says there is nothing behind it.

## Context

linq had a `users` table whose rows never logged in. A user held a name, an email, a role and a status; it acted only through API keys; and the only field of it that ever reached a request handler was `role`.

The key was already the credential. The user was a box drawn around one or more keys, and the box was not free: a table, two foreign keys, a join on every authenticated request, a second join on every link read for the owner's display name, six API routes, a settings screen built around a user-then-keys hierarchy, and a test helper reached from 48 call sites. Nothing used the grouping. No feature asked "what else does this person hold".

Separately, an instance could only be reached with a key it had no way to give you. First boot minted one, guarded on the `users` table being empty — so an instance that had lost every key but kept its users had no way back in short of raw SQL, and recovering meant copying a TypeScript snippet out of the README into a file and running it.

## Decision

**A key is the principal.** `api_keys` carries `name` and `role`; the `users` table and the `user_status` enum are dropped. Authentication is one indexed lookup by key hash and no join.

**A key owns the links it creates**, and `links.owner_id` points at `api_keys`. The four-role ladder is unchanged — `author` still means "manages what it owns", where *it* is now a key.

**`owner_id` is nullable, `ON DELETE SET NULL`.** This is the one place the requirements collided. Revocation is a real delete, and a key owns links, so under the old `RESTRICT` a leaked key could not be revoked until someone moved its links first. A credential you cannot revoke on demand is not a credential you control, so revocation wins: the links survive, unowned, editable by a manager or admin and adoptable by transfer.

That decision reaches further than the schema. Every link read joins for the owner's name, and under an inner join a link whose owner had been revoked would vanish from every list rather than appear unowned. The join is a `leftJoin`, and there is a test that says so.

**A key has no disabled state.** It has a name, a role, an expiry and a revoke. Disabling was a user-shaped idea; a key you no longer want is one you delete.

**An instance with no keys mints one and prints it.** An install that cannot be reached is not useful, so first boot still hands the operator an admin key on stdout, once. `LINQ_INITIAL_API_KEY` is gone: the secret is always generated, never pinned from the environment where it would sit in a shell history and a compose file.

The guard is **"no keys", not "never booted"** — the old one asked whether any *user* existed, which is the wrong question once the key is the principal. An instance whose last key was revoked now mints itself a way back in on the next restart instead of becoming permanently unreachable.

**`bun run key:create --name ops --role admin` is the fallback**, for a key without a restart, and it shares its implementation with boot and with `POST /api/v1/keys` — three callers, one `createApiKey`, so they cannot drift in what they store or how they hash it.

**Two self-guards survive the move**, because their reasoning did: nobody changes the role of the key they are calling with, and nobody revokes it. Both were "do not lock the instance out of its own API". Neither is fatal any more — a restart or the CLI both mint a way back in — but a guard that keeps a working key working is cheaper than either.

## Consequences

- Authentication does one query instead of a join, and `Principal` carries the name, so `/me` needs no second lookup either.
- **`/me` returns the key**, not a user wrapper. The Client UI's server probe used a missing `user` object as its "this is not a linq server" test, so client and server have to ship together; a stored key keeps working, but an old client cannot probe a new server.
- **Email is gone.** Nothing read it except the settings screen, but it was the only contact detail the system held. A key's name is now the only answer to "who is this for", and it is neither unique nor verified — two keys called `ops` are indistinguishable in the owner column.
- **Rotation is mint, transfer, revoke.** A new key does not inherit the old key's links. The transfer endpoint already existed and was retargeted; no new concept was added, but rotation is now a three-step operation someone has to remember.
- **Revocation is destructive in a way disabling was not.** A disabled user could be re-enabled. A revoked key cannot, and its links do not return to anyone when a replacement is minted.
- **A plaintext admin key reaches stdout on first boot**, and on any boot after every key is gone. It is deliberately not written through the logger: a secret in a rotating file on a mounted volume outlives the terminal line by a long way. An operator who pipes stdout to a file has undone that, and nothing stops them.
- **Revoking every key is recoverable by restarting**, which is convenient and is also a way back in for anyone who can restart the process. On a self-hosted instance that is the same person; it is worth naming rather than discovering.
- Migration `0009` discards every existing key and every link's ownership rather than guessing which of a user's several keys should inherit them. Acceptable only because nothing had shipped, and stated in the migration rather than left for a reader to discover.
- **A key's role may not be lowered below the ownership threshold while it still owns links** (`docs/plans/Plan_26.md` Part B, amending the note below). Reassigning them (`POST /keys/:id/links/reassign`) or revoking the key outright is the way through; revocation itself stays unconditional, exactly as this ADR requires.

## Amendment: a viewer may still hold links via demotion (2026-09-20, docs/plans/Plan_25.md)

A viewer can no longer *become* a link's owner — a transfer to a viewer key is refused (409). But `owner_id` still tolerates a key whose role was reduced to viewer after it owned links: demoting an owner is unconditional, exactly like revoking it, for the same reason. The link's `editLink` permission strips that key's edit rights the moment the demotion lands, so the state is safe, and it is the same shape as an unowned link — a row whose owner cannot currently act on it — which this ADR already accepts.

## Amendment: demotion below the ownership threshold is refused while links are owned (2026-09-20, docs/plans/Plan_26.md)

**Supersedes the "demoting an owner is unconditional" line above.** That claim is no longer true: `PATCH /keys/:id` now refuses to lower a key's role below `can.ownLink`'s threshold while it still owns links, the same conflict shape as a transfer to an ineligible key. The reasoning above was sound on its own terms but incomplete — it answered "is the resulting state safe", not "should the transition itself be free" — and the objection to blocking it (holding an access reduction hostage to data cleanup, the same thing this ADR refuses to do for revocation) is answered rather than overruled: a bulk reassign endpoint gives the operator a one-call remedy *before* the refusal ever ships, so the demotion is never blocked without an immediate way through.

**Revocation is untouched and stays the unconditional escape hatch.** `DELETE /keys/:id` still succeeds regardless of how many links a key owns, leaving them unowned via `ON DELETE SET NULL`, exactly as the Decision above requires. Demotion is housekeeping; revocation is incident response, and it remains one call.

A key demoted before this amendment shipped may still own links — that pre-existing state is tolerated, not migrated, the same forward-only stance every amendment here has taken.
