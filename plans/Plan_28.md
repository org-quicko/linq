# linq — Plan 28: fix role routing & navigation for viewers, and embed rules editing in LinkFormDialog

Follows `plans/Plan_27.md`.

## Context

Two problems were raised:
1. **500 error & role functionality for viewers**: A viewer key in the frontend encountered 500 errors when viewing stats and pages, and role navigation across all four roles (`viewer`, `author`, `manager`, `admin`) needed verification and fixes.
2. **Rules in Create/Edit Link dialog**: `LinkFormDialog` (`apps/client/components/link-form-dialog.tsx`) deliberately omitted rules ("Rules stay off this dialog and on `/links/detail/` where they've always lived", `link-form-dialog.tsx:40`), leaving users with no way to configure or modify redirect rules when creating, editing, or duplicating a link from the dialog.

---

## Part 1: Root Cause Analysis & Role Audit

### 1. Root cause of the 500 internal error
Inspection of `data/logs/linq.1.log` revealed:
```
PostgresError: column links.image_url does not exist
at DrizzleQueryError: Failed query: select "links"."id", ..., "links"."image_url" ... from "links" ...
```
When `apps/server/src/db/schema.ts` was briefly modified to include `image_url` during earlier exploration, Bun's hot-reloader (`bun --watch src/main.ts`) immediately reloaded the running server against the existing PostgreSQL database. Because no migration had run against the live database, all link queries (`/api/v1/links`, stats aggregates, etc.) threw an unhandled Postgres column error that bubbled up as `500 internal server error`.

Reverting `schema.ts` restored clean operation (verified in `data/logs/linq.1.log`: server restarted and all queries return 200).

### 2. Frontend navigation barriers for viewers and non-admins
Auditing all 4 roles across every API endpoint and client page revealed two critical UX and routing barriers:

1. **`/settings/` redirect locks out non-admins**:
   - `apps/client/app/settings/page.tsx` unconditionally redirects visitors to `/settings/keys/`:
     ```ts
     router.replace("/settings/keys/")
     ```
   - However, `/settings/keys/` is gated by `AppShell requires={can.manageKeys}` (admin only).
   - When a viewer, author, or manager clicks "Settings" in the sidebar, they are redirected to `/settings/keys/` and hit "You don't have access to this page."
   - **Resolution**: Redirect `/settings/` to `/settings/domains/`. `Domains` is readable by all roles (`viewer`, `author`, `manager`, `admin`), while `SettingsNav` dynamically shows or hides the `Keys` sub-nav based on `can.manageKeys`.

2. **Inability for viewers to navigate to link details from `/links/`**:
   - In `apps/client/app/links/page.tsx`, `LinkRow` rendered `<ShortLink link={link} />` without passing an `href`.
   - The only way to reach a link's detail page was through the row action menu (`DropdownMenu`).
   - But the row action menu is gated by `editable || duplicatable`, which are both `false` for viewers (`viewer` has no edit or create permissions).
   - As a result, viewers had no clickable path from the links list to `/links/detail/?id=...` to view stats, details, rules, or visit history.
   - **Resolution**: In `LinkRow`, pass `href={`/links/detail/${qs({ id: link.id })}`}` to `ShortLink` (matching `app/archives/page.tsx:145`). Viewers and other roles can now click the link to open `/links/detail/?id=...`.

---

## Part 2: Embedding Rules in LinkFormDialog

### 1. Design & Workflow
Currently, routing rules can only be edited on the standalone Link Detail page (`/links/detail/?id=...`). `LinkFormDialog` handles Create, Edit, and Duplicate modes for links.

To support rules directly in link creation and editing:
- **API and Schema**:
  - `packages/shared/src/links.ts`:
    - Add `rules: rulesPutSchema.default([])` to `linkCreateSchema`.
    - Add `rules: rulesPutSchema.optional()` to `linkPatchSchema`.
  - `apps/server/src/http/api/links.ts`:
    - In `POST /api/v1/links`: insert rules in the same transaction as the link creation.
    - In `PATCH /api/v1/links/:id`: when `patch.rules !== undefined`, replace rules in the same transaction.
- **Client UI (LinkFormDialog)**:
  - Add a dedicated collapsible section: **Routing rules**.
  - Displays rules with position badges (`#1`, `#2`, ...), destination URL, conditions list, condition adder/remover, reorder buttons, and delete button.
  - An "Add rule" button appends a new rule.
  - In `create` mode: sends `{ ...linkData, rules }` directly in the `POST /api/v1/links` call.
  - In `edit` mode: sends `{ ...linkData, rules }` directly in the `PATCH /api/v1/links/:id` call.

---

## Proposed Changes

### 1. Shared Package
- **[MODIFY] `packages/shared/src/links.ts`**:
  - Add `rules` to `linkCreateSchema` and `linkPatchSchema`.

### 2. Server API
- **[MODIFY] `apps/server/src/http/api/links.ts`**:
  - Handle atomic rules insertion in `POST /api/v1/links`.
  - Handle atomic rules replacement in `PATCH /api/v1/links/:id`.

### 3. Client Routing & Navigation
- **[MODIFY] `apps/client/app/settings/page.tsx`**:
  - Change redirect destination from `/settings/keys/` to `/settings/domains/`.
- **[MODIFY] `apps/client/app/links/page.tsx`**:
  - Pass `href={`/links/detail/${qs({ id: link.id })}`}` to `ShortLink` in `LinkRow`.

### 4. Client Rules Integration in LinkFormDialog
- **[MODIFY] `apps/client/components/rules-editor.tsx`**:
  - Export `RuleDraft`, `blankCondition`, and `RulesList` for shared use.
- **[MODIFY] `apps/client/components/link-form-dialog.tsx`**:
  - Pre-fill rules when editing or duplicating via `useGetLinkRulesQuery`.
  - Add collapsible "Routing rules" section to dialog.
  - Include `rules` directly in create and update mutations.

---

## Verification Plan

### Automated Tests
1. Run role audit test (`scratch/audit-roles.ts`) confirming all 4 roles receive expected status codes (200 for reads, 403 for unauthorized writes).
2. Run full test suite: `bun run test` (315+ tests pass).
3. Add client tests or component tests if applicable.

### Manual Verification
1. Log in with a `viewer` key:
   - Verify `/links/` loads link list without error.
   - Click a link in `/links/` and verify navigation to `/links/detail/?id=...` works smoothly, rendering stats, summary, rules (read-only), and visit log.
   - Click "Settings" in the sidebar and verify it opens `/settings/domains/` without "Access Denied" errors.
   - Verify `/analytics/` loads overview, traffic stats, and visit log without error.
2. Log in with an `author`, `manager`, or `admin` key:
   - Open "Create link" dialog.
   - Expand "Routing rules", add a rule with platform / query param condition.
   - Save link and verify the rules are saved and applied.
   - Edit an existing link, modify its rules, save, and verify updates persist.

