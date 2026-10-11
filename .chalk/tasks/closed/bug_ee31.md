---
id: bug_ee31
title: Fix resolve-outdated-thread GraphQL query (pullRequestReviewThread field doesn't exist)
type: bug
status: closed
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-10-11T03:29:24Z
updated_at: 2026-10-11T03:31:52Z
---


## Context

PR #82 added `resolveOutdatedThreads` (rereview.ts). It queried
`node(id) { ... on PullRequestReviewComment { pullRequestReviewThread { id isResolved } } }`,
but `PullRequestReviewComment` has no such field (verified by introspection), so every
attempt failed in production (46 `resolve-outdated-thread-failed` log lines). Reviews still
published (errors are caught) but outdated threads were never resolved. Unit tests passed
because their mock returned the same non-existent shape.

## Plan

- [x] Introspect real schema (PullRequestReviewThread, ResolveReviewThreadInput, MinimizeCommentInput)
- [x] Replace per-comment lookup with one paginated `pullRequest.reviewThreads` query; match thread comments by node id
- [x] Skip already-resolved threads and threads with none of Magpie's comments
- [x] Thread owner/repo/prNumber from pipeline.ts
- [x] Rewrite tests with real-shape fixtures: pagination, resolved, non-Magpie, error paths
- [x] build + test green
- [x] Sanity-check other GraphQL (minimizeComment) against schema
- [x] Docs: App perms (docs/QUICKSTART.md "Pull requests: Read and write") already cover reviewThreads + resolveReviewThread; no change

## Review

Fixed by listing reviewThreads (100/page, cursor-paginated, one query per page) and resolving
matching unresolved threads. minimizeComment input (subjectId, classifier OUTDATED) verified
against schema. resolveReviewThread input (threadId: ID!) verified by introspection; the
mutation itself was not exercised. Unrelated flaky reviewer.test.ts abort test failed once, passed on rerun.
