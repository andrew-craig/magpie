---
id: task_2f46
title: M8-D1: tier preflight + isolation-ladder selection module
type: task
status: open
priority: 1
labels: [security,ladder]
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:55:40Z
updated_at: 2026-07-23T08:28:41Z
---
Brief §5 tier-honesty invariant. A module that probes the host and selects the strongest
available tier: micro-VM (KVM) > gVisor (deferred, slot exists) > hardened crun.

- [ ] KVM probe: actually open /dev/kvm and issue KVM_CREATE_VM — never CPU-ID registers, which
      can misreport. (Probe binary is a Rust candidate per RUST-1 — the installer preflight must
      run without Node.)
- [ ] Probe podman/krun presence + version pins; leave a wired-but-empty gVisor slot (task_624d
      stays deferred per CTO decision 4).
- [ ] Install-time preflight FAILS LOUD and requires explicit operator acknowledgement (e.g.
      MAGPIE_ACK_TIER=crun or an installer prompt) before landing on a weaker tier — silent
      degradation is the sin this exists to prevent.
- [ ] Runtime: orchestrator re-runs the probe at startup, logs the active tier, refuses to start
      if the tier is weaker than the acknowledged/configured one.
- [ ] Extends the existing docker.ts 'docker version' preflight slot (brief §8).

Done when: tier selection is a single auditable module, degradation always requires explicit
acknowledgement, and the selected tier is what actually launches jobs.
