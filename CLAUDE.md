# Project conventions — Atlas-driven development

This repo has an Atlas dashboard at `atlas/` and a knowledge base at `kb/`.
The flow below applies to **every Claude Code session** working in this
repo (humans and agents alike).

> **Enforcement is automatic via the Atlas plugin hooks** (claim-first edits,
> commit/PR id checks, stop-after-PR for review, backlog validation). If a hook
> blocks an action, read its stderr remedy and follow it. This file is guidance
> to help you stay on-flow; the hooks are the backstop.

The hooks are backed by:

- The `atlas-compliance.yml` GitHub Action (blocks PRs that skip the system)
- The PR template (`.github/pull_request_template.md`)
- The `/atlas-claim` skill (guided story claiming — the easy path is the right path)

---

## Before writing any code

1. **Find the story you're working on.** Read `atlas/backlog.json` →
   `stories[]`. If the user hasn't named a story, ask which one. If it's not
   in the backlog yet, run `/atlas-update` to add it (don't just start coding).

2. **Read the linked knowledge base.** Look at the story's `kb_articles[]`.
   For each slug, find the matching article in `kb/_index.json` → fetch the
   `path` field → read the markdown. These articles are the architectural
   context the team already established. Re-deriving instead of reading is
   waste.

3. **Confirm the acceptance criteria.** Story `acceptance[]` is the gate the
   PR will be merged against. If a criterion looks wrong or missing, surface
   it before coding — don't silently work around it.

## While building

- **Branch naming:** `feat/<story-id>-<short-slug>` — e.g.
  `feat/S1.2-connector-layer`. The story ID in the branch lets the
  reconciler match without parsing the PR title.

- **Commits:** include the story ID in the message — `feat(S1.2): add SF
  client retry logic`. Helps with later git archeology and lets the
  reconciler track multi-commit stories.

- **If reality diverges from the story:** stop and either (a) note it in
  the PR description so the reviewer can decide, or (b) open a separate
  `atlas:backlog-change` PR via `/atlas-update` to refine, split, defer, or
  merge the story. The plan is allowed to change — it just has to change
  through the same review path as code.

## Before opening a PR

- **PR title:** must contain the story / claim / task ID in parens — e.g.
  `feat(S1.2): connector layer`. The atlas-compliance check rejects PRs
  without a recognized id.

- **Use the PR template.** Fill all three sections: story link, AC checklist,
  KB articles read. The compliance comment will auto-paste these against the
  live backlog state for the reviewer.

- **Run locally:** `npm run atlas:dev` then visit `http://localhost:8788/`.
  Click your story → DrillDownPanel — verify the AC + KB references look right.

## When the PR merges

- The reconciler will flip the story (and all child tasks under it) to
  `merged` automatically. No manual update needed.

- If the build revealed new context worth capturing in the KB, write the new
  article (or update an existing one) in `kb/`, run `npm run atlas:kb`, and
  include the index update in the PR or a follow-up.

---

## Quick reference

| Need | Do |
|---|---|
| Pick the next story | `/atlas-claim` |
| Change a story (refine / split / defer) | `/atlas-update` |
| See the current plan | `npm run atlas:dev` → http://localhost:8788/ |
| Compile the KB index | `npm run atlas:kb` |
| Refresh engineering stats | `npm run atlas:stats` |

The Atlas isn't paperwork. It's the shared source of truth for what we're
building and why. If you find yourself working around it, that's a signal —
either the Atlas is out of date (fix it with `/atlas-update`) or the story
needs to be claimed first (use `/atlas-claim`). The hooks will surface the
right remedy in their stderr output when something is out of order.
