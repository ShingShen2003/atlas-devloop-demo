# Atlas Dev-Loop Demo

A tiny app built **end-to-end through the Atlas plugin's enforced dev-loop**.

The only thing in the baseline is the **Atlas tooling** (config, backlog, reconciler,
CI compliance check) + this README. Every feature — the app scaffold, priority badges,
and footer — is **earned through the loop**: claim a story → build → open a PR that
references the story → the `atlas-compliance` check + branch protection require that
reference before the merge into `main` is allowed → the reconciler advances state →
post-deploy QA sign-off in the hub flips it to `verified`.

Backlog: **S1** scaffold → **S2** priority badges → **S3** footer (each depends on the prior).
