---
id: epic_59b1
title: Milestone 8 — Rootless micro-VM reviewer sandbox (CTO-approved synthesis)
type: epic
status: open
priority: 1
labels: [security,milestone-8,microvm]
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-07-19T22:52:53Z
updated_at: 2026-07-19T22:52:53Z
---
CTO approved (2026-07-19) the §5 synthesis in docs/design/cto-decision-brief.md: rootless KVM
micro-VM reviewer sandbox — libkrun/krun under rootless Podman — on Proposal B's rootless
substrate, with the three-tier isolation ladder (micro-VM > gVisor > hardened crun) and no root
anywhere. This retires the M6-E shim direction (Proposal A) as the mid-term target.

Approval carries four binding edits — these are constraints on every task in this epic:

1. **Secret split is a MERGE BLOCKER, not a follow-up.** The orchestrator ⟂ gateway uid
   separation must hold in every tier from the first landed commit. B-as-written's collapse of
   the provider key into the untrusted-input-parsing process must never exist on main, even
   transiently.
2. **Spike-failure decision rule.** If libkrun fails the §7.1 gate, do NOT auto-proceed to
   Firecracker-direct. Owning a per-arch guest-kernel/rootfs pipeline is a scope change that
   goes back to the CTO with an updated estimate. The spike is timeboxed to TWO WEEKS,
   including the 16 KB-page arm64 box.
3. **The floor invariant gets a regression test, not just doc language.** CI or preflight must
   assert the crun tier's flag set is byte-for-byte today's shipped hardened posture, so the
   floor can't silently erode while attention is on the micro-VM path.
4. **No isolation tier in the public PR review footer** (attacker recon: a prospective attacker
   must not learn pre-submission whether the target runs the crun floor). Tier goes to /healthz
   and operator logs only.

Also mandated: the guest-side vsock client is a **static native binary, built in our CI, covered by
the same cosign signing as the reviewer image** (Node has no native AF_VSOCK). Language is **Rust**
per the M8-A1 spike (was open Go-or-Rust; resolved to Rust — the host-side libkrun launcher forces
a C-ABI-FFI language and the guest client is proven in Rust) — see the Rust adoption epic
(`epic_6955`) for the pipeline and migration-scope decision.

Task phases: A = gates/spikes → B = rootless substrate (merge-blocker constraints) →
C = micro-VM tier → D = ladder/installer/surfacing/docs. gVisor stays deferred (CTO decision 4);
task_624d is reparented here as the deferred middle tier.
