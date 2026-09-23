---
name: linq-plan
description: Write a new design plan for a linq change before implementing it. Use when asked to plan, design, or scope non-trivial work in this repo.
---

# Writing a plan

Design plans go in `docs/plans/Plan_N.md`, numbered sequentially, and are reviewed
before any code is written from them.

## File

`docs/plans/Plan_N.md` — `N` one higher than the current highest file in `docs/plans/`
(check the directory; don't assume the count from memory). If the work
continues an earlier plan, say so up top: `Follows docs/plans/Plan_N.md.`

## What goes in it

Not just what was decided, but the reasoning: alternatives considered, what
was verified on disk or in docs before ruling one out, and why the rejected
option was rejected — including grep/searches actually run to confirm a
claim, not assumed.

## Stop after writing

**Writing a plan is not implementing it.** Stop once the file is written and
ready for review — don't start building from it unless the user explicitly
asks you to.
