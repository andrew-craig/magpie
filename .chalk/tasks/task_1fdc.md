---
id: task_1fdc
title: M8-A1: libkrun-under-rootless-Podman spike — timeboxed 2 weeks incl. 16 KB-page arm64
type: task
status: open
priority: 1
labels: [spike,gate,microvm]
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:53:33Z
updated_at: 2026-07-19T22:53:33Z
---
The single pre-implementation gate (brief §7.1), approved with a HARD TIMEBOX: two weeks total,
including the 16 KB-page arm64 box (the hardest case). The question it answers: does libkrun/krun
behave as a drop-in OCI runtime under rootless Podman for our existing mount/env/argv contract?

Checklist:
- [ ] Rootless podman + krun boots the existing magpie-reviewer OCI image as a micro-VM guest on
      a representative amd64 host.
- [ ] Same on the 16 KB-page arm64 box (libkrun's bundled aarch64 guest kernel is
      CONFIG_ARM64_4K_PAGES=y; KVM stage-2 granule is independent of guest stage-1 — confirm in
      practice, not just in theory).
- [ ] /dev/kvm access via kvm-group membership; carry crun #1894 — if krun needs more, prefer
      setfacl -m u:<svc>:rw /dev/kvm; world-0666 is a real permission regression and is NOT
      acceptable.
- [ ] Read-only virtiofs /work mount of a PR checkout works for Pi's read tools.
- [ ] Confirm the guest-vCPU ceiling and measure boot-to-userspace on the real reviewer rootfs.
- [ ] Confirm guest RAM ceiling is VMM-enforced (memory-bomb containment) as validated for
      Firecracker in the brief appendix.
- [ ] Write up pass/fail against each gate item in this task file.

Decision rule on failure: STOP — see the companion decision task. Do NOT start Firecracker-direct
work. Timebox expiry without a pass counts as a fail for the decision rule.

Done when: written pass/fail spike report exists here and the go/no-go decision task is
unblocked with evidence.
