---
id: task_624d
title: M6-C: gVisor (runsc) runtime for the reviewer container
type: task
status: open
priority: 3
labels: []
blocked_by: []
parent: epic_3c41
remote_task_url: null
created_at: 2026-07-10T21:53:21Z
updated_at: 2026-07-10T21:53:21Z
---
PLAN.md milestone 6. Defense-in-depth against container/kernel escape: run the magpie-reviewer container under gVisor.

- Install runsc, register it as a docker runtime, and add a config knob (e.g. container.runtime, default runc) so docker run gains --runtime=runsc when enabled — building on M3's runner and config plumbing.
- Verify the M3 hardening flags (read-only rootfs, tmpfs, cap-drop, pids/mem/cpu limits) and the M4 magpie-net egress lockdown all still hold under runsc, and that Pi's runtime (node, git-less worktree reads) works; measure the overhead on a real review.
- Document the fallback: if gVisor breaks something, the knob flips back to runc without code changes.

Done when: an end-to-end review passes with container.runtime=runsc and the M4-E startup assertions still pass.
