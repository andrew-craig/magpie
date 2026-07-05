---
id: task_3c49
title: Event filtering + repo allowlist gating
type: task
status: open
priority: 1
labels: []
blocked_by: [task_9c52,task_9af4]
parent: epic_04f9
remote_task_url: null
created_at: 2026-07-05T22:57:34Z
updated_at: 2026-07-05T22:57:34Z
---
Decide which verified webhook events actually turn into review jobs.

Context: Only some pull_request actions should trigger a review, and only on repos we've opted into. This sits between the webhook receiver and the job queue.

Scope:
- Subscribe to the verified-event seam from the webhook server.
- Act only on pull_request actions: opened, ready_for_review, reopened, synchronize. Ignore everything else.
- IGNORE draft PRs.
- Gate on the repo_allowlist from config (base.repo.full_name); drop events from repos not on the list (log at debug).
- Extract and pass forward the fields a job needs: owner, repo, PR number, head.sha, base.repo.full_name, installation id, and (for synchronize) the before/after SHAs for later incremental use.
- Hand accepted events to the queue. For M1, full-diff review is fine — incremental synchronize dedup is a later milestone; just don't crash on synchronize.

Acceptance criteria:
- Draft PRs and non-matching actions produce no job.
- Events from non-allowlisted repos produce no job.
- Accepted events produce a well-formed job descriptor handed to the queue.

Dependencies: task_9c52 (allowlist config), task_9af4 (event source).
