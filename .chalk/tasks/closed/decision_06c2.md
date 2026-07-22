---
id: decision_06c2
title: M8-A2: spike go/no-go — if libkrun fails, escalate to CTO; no auto-fallback to Firecracker-direct
type: decision
status: closed
priority: 1
labels: [gate,decision]
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:53:43Z
updated_at: 2026-07-22T12:57:55Z
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

---

## DECISION (2026-07-22): GO — libkrun confirmed. C-phase proceeds on libkrun.

Spike `task_1fdc` returned **PASS** within the two-week timebox (started 2026-07-20, well inside
the 2026-08-03 expiry). Written pass/fail against every §7.1 gate item is recorded in that task
file and in `spike/m8-a1/{flag,frontend}-investigation.md`, each claim paired with real command
output on the 16 KB-page arm64 host (the hardest case).

Per CTO edit 2, the go/no-go rule is satisfied on the PASS branch: **no Firecracker-direct
escalation is needed**; no per-arch guest-kernel/rootfs pipeline is taken on. The C-phase
micro-VM tasks (`task_76d6` launcher, `task_39ff` tier e2e, `task_3b48` no-network assertion,
`task_a163` vsock transport, `task_b3f7` forwarder) proceed on libkrun.

Two things this decision carries forward (already reflected elsewhere, noted here for the record):
- The front-end is the **direct-libkrun launcher**, not the crun krun handler — that is what
  delivers provable no-network + non-root + the gateway vsock channel (`task_76d6`).
- amd64 remains unvalidated (no hardware); it is a C-phase/CI item, not a reopened gate.
