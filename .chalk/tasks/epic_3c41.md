---
id: epic_3c41
title: Milestone 6 — Nice-to-haves (on-demand review, per-repo config, gVisor, multi-provider)
type: epic
status: open
priority: 3
labels: [milestone-6]
blocked_by: [epic_d6c1]
parent: null
remote_task_url: null
created_at: 2026-07-10T21:52:44Z
updated_at: 2026-07-10T21:52:44Z
---
PLAN.md milestone 6: deliberately-later improvements once the core loop is hardened and in production. Each sub-task is independent — pick them up individually as wanted; none blocks another. Scope per PLAN.md: @magpie review comment command for on-demand re-review; per-repo config via .magpie.toml read from the BASE branch only (never the PR head, to keep config out of attacker control); gVisor (runsc) runtime for the reviewer container; multi-provider support beyond OpenRouter.
