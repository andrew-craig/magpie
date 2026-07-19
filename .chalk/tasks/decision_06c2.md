---
id: decision_06c2
title: M8-A2: spike go/no-go — if libkrun fails, escalate to CTO; no auto-fallback to Firecracker-direct
type: decision
status: open
priority: 1
labels: [gate,decision]
blocked_by: [task_1fdc]
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:53:43Z
updated_at: 2026-07-19T22:53:43Z
---
CTO edit 2, verbatim rule: if libkrun fails the §7.1 gate (including timebox expiry), do NOT
auto-proceed to Firecracker-direct. That fallback means owning a per-arch guest-kernel/rootfs
pipeline permanently and pushes the estimate meaningfully higher — a scope change that returns
to the CTO with the updated estimate.

- [ ] On spike PASS: record the decision here, close, and the C-phase tasks proceed on libkrun.
- [ ] On spike FAIL: write the failure analysis + an updated Firecracker-direct estimate
      (guest-kernel/rootfs supply chain per architecture, mkfs.ext4 /work image path from brief
      §6.2, ongoing kernel CVE ownership) and take it to the CTO. No Firecracker implementation
      task may be created until that approval lands.

Done when: the decision (libkrun confirmed, or CTO-approved alternative) is recorded here.
