---
id: task_1ffd
title: M4-E: fail-closed startup assertions in the container entry script
type: task
status: open
priority: 1
labels: []
blocked_by: [task_eaf9,task_bbdd]
parent: epic_6730
remote_task_url: null
created_at: 2026-07-10T21:51:30Z
updated_at: 2026-07-10T21:51:30Z
---
Wave 3 (final M4 task; needs the gateway wiring and the network lockdown in place). PLAN.md milestone 4's explicit acceptance check.

Extend the magpie-reviewer entry script to verify its own confinement before running Pi, and exit non-zero (fail closed, surfaced as a review failure comment) if:
- any host other than the configured gateway is reachable (probe a couple of canaries, e.g. github.com and a raw public IP, and require them to FAIL; require the gateway health endpoint to succeed), or
- a long-lived provider key is present in the container env (e.g. OPENROUTER_API_KEY or any configured real-key variable) — only the per-job virtual key is allowed.

Keep the probes cheap and bounded (short timeouts) so they don't eat the job clock. Add an integration test or documented manual check demonstrating both failure modes actually abort the run.

Done when: deliberately breaking either invariant (extra network route, real key injected) aborts the review at startup with a clear log line.
