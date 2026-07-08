---
id: task_d785
title: Stagger queue-timeout vs runReview-timeout and propagate AbortSignal into runReview
type: task
status: open
priority: 2
labels: []
blocked_by: []
parent: epic_04f9
remote_task_url: null
created_at: 2026-07-08T13:00:25Z
updated_at: 2026-07-08T13:00:25Z
---

## Problem (from PR #18 review — Magpie self-review + Gemini, both converge)

Two related timeout/cancellation gaps, deferred from PR #18 as future-milestone
hardening (grouped with task_a2db race-hardening):

### C. Queue-timeout vs runReview-timeout race
`JobQueue.#runOne` (queue.ts) starts a per-job wall-clock timer at dequeue and,
on expiry, `controller.abort()` + runs `cleanupJob` (rm -rf the workspace).
Separately, `runReview` (reviewer.ts) enforces its OWN timeout of the SAME
duration, but starting LATER (after mint-token, pulls.get, createWorkspace,
computePrDiff). So the queue timer reliably fires FIRST. When it does it
`rm -rf`s the workspace out from under a still-running `pi`, which then finishes
on an orphaned inode; worse, the pipeline's `finally` + publish path can still
post a failure comment for a job the queue already marked `timed-out`
(double-handling).

### D. Pre-review abort check
The pipeline checks `signal.aborted` before computeDiff and before runReview,
but the heavy pre-review awaits (mint-token, pulls.get, createWorkspace) run
unconditionally even if the signal is already aborted. Folds into the same
AbortSignal-propagation change.

## Fix direction (agreed in tech-lead assessment)
- Stagger the two timeouts so the queue timer is a true backstop, not the
  primary (e.g. queue timeout = review timeout + grace), OR make the queue the
  single owner of the deadline and propagate its `AbortSignal` into `runReview`
  so `pi` is actually cancelled (touches reviewer.ts's tested `runReview`
  signature — this is why it's deferred).
- Ensure a job the queue has already terminated (timed-out) does not also
  publish a failure comment from the pipeline (single terminal outcome).
- Honour `signal.aborted` before the heavy pre-review awaits (D).

## Notes
- Deferred from PR #18 (Valid-but-defer). Touches reviewer.ts's tested signature
  and is exactly the "future milestone" hardening Gemini flagged.
- Group with task_a2db (head-SHA race) — both are pipeline/job race-hardening.
