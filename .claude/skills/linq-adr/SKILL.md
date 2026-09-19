---
name: linq-adr
description: Write a new Architecture Decision Record for linq. Use when a decision is hard to reverse and the reasoning behind it needs to survive — a new infrastructure dependency, an irreversible data-model or API choice, a security/privacy boundary, or "why not the obvious alternative".
---

# Writing an ADR

`docs/adr/` holds decisions that are hard to reverse, and why — not a log of
every change. Routine feature work doesn't get one; something the team would
otherwise re-litigate or accidentally undo does.

## File

`docs/adr/NNNN-kebab-case-title.md` — a 4-digit number one higher than the
current highest file in `docs/adr/` (check the directory; don't assume the
count from memory).

## Structure

Follow the existing ADRs exactly (e.g. `docs/adr/0012-caddy-is-the-tls-terminator.md`):

```markdown
# NNNN – Title

**Status**: accepted · YYYY-MM-DD.

## Context

## Decision

## Consequences
```

- **Context**: the constraint or problem that forced a choice — what was true
  before, what was missing or broken.
- **Decision**: what was chosen, stated precisely enough to act on, including
  the mechanism (not just the intent).
- **Consequences**: what this costs, forecloses, or still depends on —
  existing ADRs are explicit about edge cases and what *doesn't* change
  (e.g. "this is not the same call ADR 0009 makes about Redis").

Write for a reader who wasn't in the discussion: state why the obvious
alternative was rejected when there was one, the way `docs/adr/0012` explains
per-domain Caddy sync over a full-list `PUT`. Cross-reference other ADRs by
number when a decision interacts with one.
