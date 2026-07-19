---
id: task_df53
title: M8-C5: orphan cleanup — reap VM/podman processes instead of docker kill targets
type: task
status: open
priority: 2
labels: [microvm,reliability]
blocked_by: [task_39ff]
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:55:29Z
updated_at: 2026-07-19T22:55:29Z
---
orphan-cleanup.ts today reaps orphaned review containers via the docker CLI. Under the new
substrate the orphan population changes: rootless podman containers (crun tier) and krun VM
processes + their per-job vsock sockets and virtiofs daemons (micro-VM tier).

- [ ] Enumerate + kill orphaned podman containers by the existing per-job naming convention.
- [ ] Reap orphaned krun/VMM processes and stale per-job uds_path sockets after crash/restart.
- [ ] Ensure gateway virtual keys for reaped jobs are revoked (existing cleanup contract).
- [ ] Test: kill -9 the orchestrator mid-review; on restart everything is reaped and the next
      review runs clean.

Done when: post-crash restart leaves no orphaned VM/container/socket and the reap is covered by
a test.
