---
id: task_9b61
title: End-to-end integration on a test repo
type: task
status: open
priority: 1
labels: []
blocked_by: [task_292c]
parent: epic_04f9
remote_task_url: null
created_at: 2026-07-05T22:58:17Z
updated_at: 2026-07-07T12:48:37Z
---
Wire the pieces into one pipeline and prove the full loop against a real test repo — the milestone exit criterion.

Context: All the individual pieces exist by now; this task connects them and validates the whole walking skeleton: webhook -> filter -> queue -> (clone -> diff -> Pi -> post). Runs on the host with smee.io relaying webhooks; no container/tunnel/gateway yet.

Scope:
- Assemble the per-job pipeline: for an accepted event, the queue runs clone -> diff -> Pi -> post comment, with cleanup on success/failure/timeout.
- A single top-level entrypoint that starts config load, the webhook server, the filter, and the queue together.
- Create/prepare a TEST REPO and install the dev GitHub App on it; add it to the repo_allowlist.
- Run the full flow: open a PR on the test repo and confirm magpie posts a summary comment automatically.
- Write a short README/runbook section: how to configure, run the relay + orchestrator, and reproduce the demo.

Acceptance criteria:
- Opening a non-draft PR on the allowlisted test repo results in one magpie summary comment, end-to-end, with no manual steps beyond opening the PR.
- The workspace is cleaned up after the job.
- The run is documented well enough to repeat.

Dependencies: task_d4a8 (dev relay), task_3c49 (event filtering), task_6431 (queue), task_292c (post comment) — which transitively pull in auth, clone, diff, Pi.
