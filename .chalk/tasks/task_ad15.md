---
id: task_ad15
title: M6-A: @magpie review — on-demand re-review via PR comment command
type: task
status: open
priority: 3
labels: []
blocked_by: []
parent: epic_3c41
remote_task_url: null
created_at: 2026-07-10T21:52:56Z
updated_at: 2026-07-10T21:52:56Z
---
PLAN.md milestone 6. Let a human request a review by commenting '@magpie review' on a PR.

- Subscribe the GitHub App to issue_comment events; webhook filter accepts created comments on PRs whose body matches the command (tolerant of surrounding whitespace/text).
- Authorization: only act on commenters with write/admin association on the repo — comment bodies are attacker-controlled (the threat model's whole point), so the command must not be triggerable by arbitrary users. Repo allowlist still applies.
- Reuse the normal pipeline (queue dedup, current head SHA); force a full (non-incremental) review even if the head SHA was already reviewed — that's the use case. React to the comment (eyes/rocket) or reply briefly so the requester knows it was picked up.

Done when: a maintainer comment triggers a fresh review, and the same comment from a non-collaborator does nothing (logged, no reply).
