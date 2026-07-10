---
id: task_4a75
title: M5-C: re-review dedup + comment minimization — reviewed-SHA marker, minimizeComment(OUTDATED)
type: task
status: open
priority: 2
labels: []
blocked_by: [task_a193]
parent: epic_d6c1
remote_task_url: null
created_at: 2026-07-10T21:52:22Z
updated_at: 2026-07-10T21:52:22Z
---
Wave 2 (builds on M5-B's synchronize handling). PLAN.md §7 re-review dedup, so the PR doesn't fill with stale bot reviews.

- Embed a hidden HTML marker in every magpie summary: <!-- magpie:reviewed:<head-sha> -->. Before reviewing, read magpie's own prior comments/reviews on the PR to find the last-reviewed SHA — stateless tracking from GitHub itself (no local DB). Skip the job if the current head SHA is already reviewed (dedup for replayed/duplicate webhooks).
- The last-reviewed SHA is also the natural 'before' for M5-B's incremental range when it's more reliable than the webhook payload.
- After posting a new review, minimize magpie's previous summary comments via the GraphQL minimizeComment mutation with classifier OUTDATED (needs the GraphQL endpoint with the installation token; verify the App permissions cover it). Minimize only magpie's own comments, matched by the existing marker — never touch human comments.
- Failures to minimize must not fail the job (log and continue).

Done when: pushing three times to a PR leaves one visible current review, older magpie summaries minimized as outdated, and a redelivered webhook for an already-reviewed SHA is a no-op.
