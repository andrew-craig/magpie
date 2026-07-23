---
id: task_39ff
title: M8-C3: micro-VM tier end-to-end — port reviewer launch to krun under rootless podman (crun floor stays feature-flagged fallback)
type: task
status: open
priority: 1
labels: [microvm,security]
blocked_by: [task_2d6c,task_b3f7,task_76d6]
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:55:10Z
updated_at: 2026-07-23T08:28:41Z
---
Brief §8 phase 3: the core port. Launch the reviewer as a rootless KVM micro-VM (podman +
krun OCI runtime) end-to-end, with the hardened crun tier remaining as the feature-flagged
fallback (it is the ladder floor, never deleted).

Plan:
- [ ] reviewer.ts: swap the container invocation for podman-with-krun; drop the gateway
      socket-dir bind mount (vsock replaces it); add guest RAM/vCPU flags.
- [ ] container-mounts.ts: /work rides a read-only virtiofs mount in the micro-VM tier; stays a
      read-only bind mount for the crun tier. (.git-strip and read-only semantics identical in
      both.)
- [ ] Concurrency: default guest RAM ~1 GB/review; queue concurrency = floor(available_RAM/guest_RAM),
      min 1, both configurable (brief §6.4).
- [ ] Dead-VM handling (OOM/panic/timeout) maps onto the existing clear-failure-note publisher
      path; add a test.
- [ ] Uid-split check (CTO edit 1): confirm the vsock/virtiofs rewiring did not move any gateway
      credential into the orchestrator; the reviewer still receives only the per-job virtual key.
- [ ] Floor test (M8-B1) still green — the crun fallback path is byte-for-byte unchanged.
- [ ] Full e2e: webhook → queue → micro-VM review → findings → published COMMENT review, on
      amd64 and the 16 KB-page arm64 box.

Done when: micro-VM tier reviews a real PR end-to-end on both arches with the crun floor intact
behind a flag.
