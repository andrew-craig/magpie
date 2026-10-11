---
id: bug_b774
title: Fix: magpie.service restart strands rootless podman pause process in old PrivateTmp namespace
type: bug
status: closed
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-10-11T02:17:07Z
updated_at: 2026-10-11T02:22:16Z
---


## Context

magpie.service runs as User=magpie with PrivateTmp=true. Rootless podman's per-user pause process
(`catatonit -P`, in user@993.service, outside magpie.service's cgroup) survives service restarts and
every podman call joins its mount namespace. After a restart the service has a NEW private /var/tmp
but the pause process holds the OLD one, so all reviews fail with exit 125
`inspecting image: open /var/tmp/NNN: no such file or directory`. Diagnosed live 2026-10-11; killing
the stale catatonit fixed it. Manual `podman` as magpie from a shell causes the mirror-image problem.

## Plan

- [x] Add `ExecStartPre=-/usr/bin/podman system migrate` + WHY comment to systemd/magpie.service (keep PrivateTmp=true)
- [x] Check install.sh placeholder rewriting survives; add restart note to its pull step
- [x] Docs: INSTALL.md troubleshooting + upgrade note, QUICKSTART.md pull step, ARCHITECTURE.md note
- [x] Unit-content guard test (packages/orchestrator/src/systemd-unit.test.ts)
- [x] systemd-analyze verify (substituted copy) + npm test
- [ ] Operator applies unit to live host (not done here)

## Review

Chose `podman system migrate`: podman-system-migrate(1) (4.3.1, local man page) says it stops running
containers and the rootless pause process and deletes its pid file. No narrower documented command
exists (`podman system reset` is destructive). Side effects (container runtime migration, stopping
containers) are moot: it runs before the orchestrator starts, reviewers are `--rm` per-job, and
startup orphan-cleanup exists. ExecStartPre shares User=, Environment= and the PrivateTmp namespace
with ExecStart (systemd.exec). ExecStopPost omitted: start-time reset covers every path (restart,
crash, boot, post-manual-podman). Leading `-` so failure never blocks startup. install.sh's sed only
rewrites prefix/node/uid placeholders, so the line survives. Verified: systemd-analyze verify on a
uid-substituted copy only complains /usr/bin/node absent on this dev box; npm test all green.
Not verified: live behaviour of `system migrate` under the unit (no live host access by design).

## Live validation (2026-10-11)
- Rendered unit (uid 993, node at /usr/local/bin/node) differed from the installed one only by the ExecStartPre line + comments; installed to /etc/systemd/system/magpie.service (backup `magpie.service.bak-pre-bug_b774`), daemon-reload, restart while idle.
- Pause process replaced on restart (331965 → 337878); `/proc/<pid>/root/var/tmp` inode identical for the service (337815) and the new pause process (155812), distinct from host /var/tmp (55339) → the new pause shares the service's private /var/tmp.
- Prior test review (cairn-reader #420, 13:20) succeeded after a manual pause-process kill.
