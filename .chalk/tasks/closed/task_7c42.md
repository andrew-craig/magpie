---
id: task_7c42
title: Remove resolveReviewThread step from re-review (needs contents:write, never worked)
type: task
status: closed
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-11-08T01:12:47Z
updated_at: 2026-11-08T01:14:37Z
---


## Context
Live hub logs: every `resolveReviewThread` mutation since PR #87 has failed with
`Resource not accessible by integration` (0 resolved / 33 failed across 8 runs).
Resolving review threads as a GitHub App requires `contents: write`, which we will
NOT grant (minimal-permission design, ARCHITECTURE.md). Decision (user, 2026-11-08):
remove the resolve step entirely; rely on `minimizeOutdated` comment minimization.

## Plan
- [x] Delete `resolveOutdatedThreads` + its GraphQL query/mutation/types from `rereview.ts`; update module comments
- [x] Remove the call + import in `pipeline.ts`; update surrounding comments
- [x] Remove `resolveOutdatedThreads` tests in `rereview.test.ts`; fix `pipeline.test.ts` call-count expectations
- [x] Drop now-unused plumbing (e.g. comment node IDs collected only for resolution) if nothing else uses it
- [x] Update any docs mentioning thread resolution (none outside src)
- [x] typecheck + tests green

## Review
Removed `resolveOutdatedThreads` (query, mutation, types), its call in pipeline step 7a,
and the `ReviewState.resolvableReviewCommentNodeIds` field (only fed resolution).
`minimizableNodeIds` unchanged (same contents/order). Tests: orchestrator `tsc --noEmit`
clean; vitest 34 files, 550 passed / 4 skipped. −387 net lines.
