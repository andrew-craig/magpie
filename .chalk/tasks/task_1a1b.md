---
id: task_1a1b
type: task
title: "End-to-end integration on a test repo"
status: open
priority: high
parent: epic_1a01
depends_on: [task_1a13, task_1a14, task_1a18, task_1a1a]
created: 2026-07-05
---

# End-to-end integration on a test repo

Wire the pieces into one pipeline and prove the full loop against a real test
repo — the milestone's exit criterion.

## Context
All the individual pieces exist by now; this task connects them and validates the
whole walking skeleton: webhook → filter → queue → (clone → diff → Pi → post).
Runs on the host with smee.io relaying webhooks; no container/tunnel/gateway yet.

## Scope
- Assemble the per-job pipeline: for an accepted event, the queue runs
  clone (task_1a16) → diff (task_1a17) → Pi (task_1a19) → post comment (task_1a1a),
  with cleanup on success/failure/timeout.
- A single top-level entrypoint that starts config load, the webhook server, the
  filter, and the queue together.
- Create/prepare a **test repo** and install the dev GitHub App on it; add it to
  the `repo_allowlist`.
- Run the full flow: open a PR on the test repo and confirm magpie posts a summary
  comment automatically.
- Write a short `README`/runbook section: how to configure, run the relay +
  orchestrator, and reproduce the demo.

## Acceptance criteria
- Opening a non-draft PR on the allowlisted test repo results in one magpie
  summary comment, end-to-end, with no manual steps beyond opening the PR.
- The workspace is cleaned up after the job.
- The run is documented well enough to repeat.

## Dependencies
- task_1a13 (dev relay), task_1a14 (event filtering), task_1a18 (queue),
  task_1a1a (post comment) — which transitively pull in auth, clone, diff, Pi.
