---
id: task_1a14
type: task
title: "Event filtering + repo allowlist gating"
status: open
priority: high
parent: epic_1a01
depends_on: [task_1a11, task_1a12]
created: 2026-07-05
---

# Event filtering + repo allowlist gating

Decide which verified webhook events actually turn into review jobs.

## Context
Only some `pull_request` actions should trigger a review, and only on repos we've
opted into. This sits between the webhook receiver (task_1a12) and the job queue
(task_1a18).

## Scope
- Subscribe to the verified-event seam from the webhook server.
- Act only on `pull_request` actions: `opened`, `ready_for_review`, `reopened`,
  `synchronize`. Ignore everything else.
- **Ignore draft PRs.**
- Gate on the `repo_allowlist` from config (`base.repo.full_name`); drop events
  from repos not on the list (log at debug).
- Extract and pass forward the fields a job needs: `owner`, `repo`, PR `number`,
  `head.sha`, `base.repo.full_name`, installation id, and (for `synchronize`) the
  `before`/`after` SHAs for later incremental use.
- Hand accepted events to the queue (task_1a18). For milestone 1, full-diff
  review is fine — incremental `synchronize` dedup is a later milestone; just
  don't crash on `synchronize`.

## Acceptance criteria
- Draft PRs and non-matching actions produce no job.
- Events from non-allowlisted repos produce no job.
- Accepted events produce a well-formed job descriptor handed to the queue.

## Dependencies
- task_1a11 (allowlist config), task_1a12 (event source)
