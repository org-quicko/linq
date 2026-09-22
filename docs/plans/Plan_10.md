# linq — Plan 10: rename the npm package `@linq/admin` → `@linq/client`

Follows `docs/plans/Plan_9.md`.

## Context

`docs/plans/Plan_8.md` renamed the directory `apps/admin` → `apps/client` but deliberately kept the npm package name `@linq/admin` (also keeping the `dev:admin`/`build:admin` script names, the `admin` role, and "Admin UI" as product naming) — reasoning it was the same scoping already used when the URL space was renamed `/admin` → `/home` while the role and product name stayed.

Looking at `apps/client/package.json` now, that inconsistency stands out: the directory says `client`, the package name still says `admin`. This plan closes that one gap — the package identity — without touching the other three things Plan_8 deliberately kept (scripts, role, product name), which are a separate, reasonable scoping decision this doesn't revisit.

## Scope

A full-repo grep for the literal string `@linq/admin` (excluding `docs/plans/*.md`, which are frozen historical records, and `bun.lock`, which regenerates) found exactly three live references, all mechanically tied to the package name value itself — not its scripts, role, or product naming:

1. **`apps/client/package.json:2`** — `"name": "@linq/admin"` → `"@linq/client"`. This is the actual rename; everything else below is just following the reference.
2. **`Dockerfile:16`** — `RUN bun --filter '@linq/admin' build` → `'@linq/client'`.
3. **root `package.json`** — the `--filter @linq/admin` value inside three scripts:
   - `dev:admin`: `"bun --filter @linq/admin dev"` → `--filter @linq/client`
   - `build:admin`: `"bun --filter @linq/admin build"` → `--filter @linq/client`
   - `build:admin:standalone`: `"bun --filter @linq/admin build:standalone"` → `--filter @linq/client`

   The **script keys** (`dev:admin`, `build:admin`, `build:admin:standalone`) are left unchanged — Plan_8 already decided those stay, and this plan doesn't reopen that. Only the `--filter` argument's value changes, because `bun --filter` matches by package name and would silently match nothing once the package is renamed.

Then:

4. **`bun install`** (root) — regenerates `bun.lock`'s two `@linq/admin` entries (a workspace mapping and a package entry) to `@linq/client`. Not hand-edited.

**Left untouched, confirmed by grep** — no other file references `@linq/admin` as a package name:
- `README.md`'s "Admin UI" prose, and its `dev:admin`/`build:admin` command mentions — product naming and script names, both out of scope per Plan_8's precedent.
- `apps/server/src/http/admin-static.ts` (`adminRoot`, `mountAdmin`) — internal identifiers, not the package name.
- The `admin` role in `@linq/shared` — unrelated.
- `docs/adr/0006` and `docs/plans/Plan_1.md`…`Plan_8.md`/`Plan_9.md` — frozen historical records.
- No `.github` workflows exist in the repo (confirmed).

## Verification

1. `bun install` at the root — confirms the workspace resolves under the new name and `bun.lock` regenerates cleanly.
2. `bun run dev:admin` and `bun run build:admin` — both scripts must still resolve via `--filter @linq/client` and behave identically to before the rename.
3. `bun run typecheck`, `bunx biome check .`, `bun run test` — full existing suite, expecting zero behavior change since this is a package-identity rename, not a code change.
4. `grep -rn "@linq/admin"` across the repo (excluding `docs/plans/`) — should return nothing.
