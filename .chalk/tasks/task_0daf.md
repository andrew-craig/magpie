---
id: task_0daf
title: PR diff generation
type: task
status: open
priority: 1
labels: []
blocked_by: [task_ada6]
parent: epic_04f9
remote_task_url: null
created_at: 2026-07-05T22:57:46Z
updated_at: 2026-07-05T22:57:46Z
---
Compute the unified diff of the PR from the checked-out workspace, to feed to Pi as the review input.

Context: The reviewer prompt (Pi runner task) needs the PR changes: the unified diff plus the changed-file list. For M1 the full-PR diff (base...head) is sufficient; incremental before...after review is a later milestone. Also enforce the diff-size cap from config (~4k changed lines) — above it, skip or summarize-only.

Scope:
- From the workspace, determine the merge-base of the PR head against the base branch and produce the unified diff (git diff <base>...<head> semantics) plus a changed-file list.
- Return a structured result: diff text, changed files, and total changed-line count.
- Apply the diff-size cap: if changed lines exceed the configured limit, flag the job as too-large so downstream can post a summary-only/skipped notice instead of running a full review.
- Keep output shape simple and typed so the Pi runner can consume it directly.

Acceptance criteria:
- For a sample PR checkout, returns the correct unified diff and changed-file list.
- Changed-line count is computed and the cap is enforced (over-cap path is distinguishable, not a crash).

Dependencies: task_ada6 (needs the checked-out workspace).
