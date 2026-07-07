---
id: task_a2db
title: Close head-SHA race between workspace checkout and API-fetched diff
type: task
status: open
priority: 2
labels: []
blocked_by: []
parent: epic_04f9
remote_task_url: null
created_at: 2026-07-07T12:25:19Z
updated_at: 2026-07-07T12:25:19Z
---

## Problem

PR #13 (`computePrDiff()`, `packages/orchestrator/src/diff.ts`) sources the PR
diff from the GitHub API (`GET /pulls/{n}` with the `diff` media type). That
endpoint always returns the diff for the PR's **current** state, while the
workspace checkout (`workspace.ts`) is **pinned**: it fetches
`refs/pull/{N}/head` and verifies HEAD equals the webhook event's `headSha`.

If the author force-pushes (or pushes new commits) between webhook receipt and
the diff fetch, the mounted checkout and the fetched diff describe different
commits. The reviewer agent then reviews an incoherent pair — diff hunks that
don't correspond to the tree it can explore — and inline-comment anchoring may
also silently target the wrong lines.

## Fix options (pick one during implementation)

1. **Verify-and-abort:** after fetching the diff, re-read the PR's current head
   SHA (`pulls.get` JSON) and compare to the job's pinned `headSha`. On
   mismatch, abort the job (a new webhook delivery for the newer head will
   re-trigger review anyway — same rationale as the queue's crash-loss
   acceptance in PLAN.md §3).
2. **Pinned diff source:** fetch the diff via
   `GET /repos/{owner}/{repo}/compare/{baseSha}...{headSha}` with the SHAs from
   the webhook payload, so the diff is pinned to the same commit as the
   checkout. Requires plumbing `baseSha` through the filter → `JobDescriptor`,
   and note the compare endpoint has its own response-size limits.

Option 1 is the smaller change and preserves PR #13's anchoring-fidelity
rationale (diff comes from the exact endpoint the publisher anchors against);
lean that way unless implementation reveals a problem.

## Acceptance criteria

- [ ] A force-push landing between webhook receipt and diff fetch cannot
      result in a published review computed from mismatched checkout/diff.
- [ ] Mismatch path is covered by an offline test (fake Octokit, as in
      `diff.test.ts`).
- [ ] Mismatch outcome is observable in job logs (aborted/requeued, with both
      SHAs logged).
