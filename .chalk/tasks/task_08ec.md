---
id: task_08ec
title: M8-B2: rootless substrate — docker→rootless podman+crun port, orchestrator ⟂ gateway uid split preserved (merge blocker)
type: task
status: open
priority: 1
labels: [security,merge-blocker,substrate]
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:54:03Z
updated_at: 2026-07-22T21:02:13Z
---
Adopt Proposal B's rootless substrate WITHOUT B's as-written secret regression. CTO edit 1 makes
this a merge blocker: the orchestrator ⟂ gateway uid separation must hold in every tier from the
first landed commit. The provider key never lives in the process that parses untrusted PR
content — no interim commit may route gateway credentials through the orchestrator, even behind
a flag.

Plan:
- [ ] Port the reviewer launch path (docker.ts wrapper + reviewer.ts invocation) from the docker
      CLI to rootless podman with crun, keeping the exact hardened flag set — the M8-B1
      byte-for-byte floor test gates this port.
- [ ] Keep the gateway as its own unprivileged uid + separate systemd unit exactly as today; the
      per-job unix-socket handoff and mint/revoke management plane are unchanged in the crun tier.
- [ ] Orphan-cleanup: reap orphaned podman containers (docker kill targets → podman equivalents).
- [ ] Explicit review-checklist item on the PR: grep-level assertion that no provider-key env/
      config reaches the orchestrator process; document the uid layout in the PR body.
- [ ] Existing e2e review flow passes under rootless podman on a dev host (subuid/subgid + linger
      set up manually for now; installer automation is M8-D3).

Done when: main runs the full pipeline on rootless podman+crun with zero posture drift (floor
test green) and the uid split provably intact; no root daemon or docker-group grant remains in
the runtime path.
