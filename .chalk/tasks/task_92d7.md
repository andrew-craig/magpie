---
id: task_92d7
title: M8-D2: tier surfacing — /healthz + operator logs ONLY; never the public PR review footer
type: task
status: open
priority: 1
labels: [security,observability]
blocked_by: [task_2f46]
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:55:47Z
updated_at: 2026-07-19T22:55:47Z
---
CTO edit (their #2): the brief's original plan surfaced the active tier in the PR review summary
footer — REMOVED. A prospective attacker crafting a malicious PR would learn whether the target
runs the crun floor before submitting. The tier is operator-facing information only.

- [ ] /healthz gains the active tier (+ probe details: kvm present, runtime versions).
- [ ] Operator logs: log the tier at startup and per job.
- [ ] publisher.ts: assert nothing tier-identifying reaches the review body/footer — add a test
      that the published review text contains no tier/runtime strings (guards regression, since
      the brief's §8 said the opposite before the edit).
- [ ] Operator docs updated: where to see the tier, and why it is not public.

Done when: tier is visible on /healthz and in logs, and a test proves the published review is
tier-silent.
