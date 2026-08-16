---
id: task_4cce
title: Resolve review threads (not just minimize) when a fix supersedes a finding
type: task
status: closed
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-08-16T11:34:54Z
updated_at: 2026-08-16T11:38:36Z
---


## Context

rereview.ts's re-review dedup pass currently only calls GitHub's GraphQL
`minimizeComment` (classifier OUTDATED) on Magpie's prior minimizable
comments once a fresh review is posted for a new head SHA. That hides the
comment body but does NOT set the PR's "Resolved" conversation state —
GitHub tracks that separately via `PullRequestReviewThread.isResolved`,
toggled by the GraphQL-only `resolveReviewThread` mutation. There is no REST
equivalent for either mutation.

Only inline review comments belong to a review thread (issue comments and
the review-summary body don't), so only the review-comment subset of
`minimizableNodeIds` is eligible for thread resolution.

## Plan

- [x] rereview.ts: split `ReviewState.minimizableNodeIds` bookkeeping so the
      inline-review-comment subset is separately available (needed to look
      up each comment's parent thread id).
- [x] rereview.ts: add `resolveOutdatedThreads` — best-effort, per-node
      (mirrors `minimizeOutdated`'s error-isolation contract): for each
      inline review comment node id, look up its parent
      `PullRequestReviewThread` id via `node(id) { ... on
      PullRequestReviewComment { pullRequestReviewThread { id isResolved } } }`,
      skip if already resolved, else call `resolveReviewThread(input:
      {threadId})`. Never throws.
- [x] pipeline.ts: call `resolveOutdatedThreads` alongside `minimizeOutdated`
      in step 7a (same gating: only on `result.ok`, same pre-publish
      snapshot).
- [x] Update rereview.ts's module doc comment (SCOPE CONSTRAINT section) to
      describe the added thread-resolution behavior.
- [x] Typecheck / build / existing tests pass.
- [x] Add/extend unit tests for the new resolve behavior if a rereview.test
      file exists.

## Result

Implemented and verified:
- `rereview.ts`: added `ReviewState.resolvableReviewCommentNodeIds` (inline-review-comment
  subset of `minimizableNodeIds`), the `resolveOutdatedThreads` function (per-comment
  best-effort: GraphQL lookup of the comment's parent `PullRequestReviewThread` id +
  `isResolved`, then `resolveReviewThread` mutation if unresolved), and doc-comment updates.
- `pipeline.ts`: step 7a now calls `resolveOutdatedThreads` alongside `minimizeOutdated`,
  same `result.ok` gating and pre-publish snapshot.
- Tests: extended `rereview.test.ts` (new `resolveOutdatedThreads` describe block, updated
  `ReviewState` shape assertions) and `pipeline.test.ts` (updated the minimize test to also
  assert the thread-lookup call). Full `npm test` (33 files, 540 passed/4 skipped) and
  `npm run build` (all 3 workspaces) both clean.
