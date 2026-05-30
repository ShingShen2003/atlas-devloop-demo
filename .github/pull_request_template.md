<!--
  Pisteyo Atlas PR template — required fields below are checked by the
  atlas-compliance workflow. PRs without a story/claim/task reference are
  rejected at the required status check; comments + AC pasted automatically.
  Use /atlas-claim to draft this template pre-filled.
-->

## Story / Claim

<!-- The Atlas reference. ONE of: (S1.2), (C-001), (T1.1.1).
     Required — atlas-compliance.yml rejects PRs without a recognized id. -->
- **ID:** <!-- e.g. S1.2 -->
- **Title:** <!-- the story title from atlas/backlog.json — paste from /atlas-claim -->
- **Phase:** <!-- e.g. Phase 1 — Foundation -->

## Acceptance criteria

<!-- Paste from the story. Each item gets a checkbox. Tick as you implement.
     The compliance comment will re-paste this list against the live backlog;
     check it for drift before merging. -->
- [ ]
- [ ]
- [ ]

## Knowledge base — articles read

<!-- The KB articles linked via story.kb_articles[]. List the ones you actually
     read; this is the dev's attestation that the relevant context was considered.
     Empty is okay only if the story has no kb_articles. -->
- [ ] (none — story has no linked KB articles)
- [ ] [`kb/path/to/article.md`](../tree/main/kb/path/to/article.md) — _one-line takeaway_

## Notes — anything that changed during build

<!-- If you discovered that the story's title / AC / kb_articles / phase needs
     updating, capture it here. Then either update atlas/backlog.json in a
     follow-up PR, or run /atlas-update to draft the change. -->
- _none_

---

<sub>Auto-prompted by the atlas-compliance workflow. See
[the install guide](../../README.md#enforcement-model) for what each section means and why
it's required.</sub>
