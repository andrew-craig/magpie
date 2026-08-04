---
id: task_624d
title: gVisor (runsc) middle tier — deferred per CTO decision 4
type: task
status: closed
priority: 3
labels: []
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-10T21:53:21Z
updated_at: 2026-08-04T22:54:07Z
---
Rescoped 2026-07-19 by the CTO decision on docs/design/cto-decision-brief.md (was: M6-C, run
the reviewer under gVisor via docker --runtime=runsc). gVisor is now the **middle tier of the
M8 isolation ladder** — micro-VM (KVM) > gVisor > hardened crun — and is **explicitly deferred**
(CTO decision 4): a coverage/density tier for no-KVM hosts and high-concurrency operators, not
an upgrade over the micro-VM default.

When picked up (after the M8-D1 ladder module exists, which carries a wired-but-empty gVisor
slot):

- Register runsc as a rootless-podman OCI runtime (not docker) and fill the ladder's gVisor slot
  so tier selection prefers it over crun on eligible hosts.
- Eligibility gating in the M8-D1 preflight: amd64 or 4 KB-page arm64 only — the official arm64
  runsc build cannot boot on 16 KB/64 KB-page kernels (brief §4.1); probe, don't assume.
- Floor invariant applies: the gVisor tier launch must carry the same hardened flag set asserted
  by the M8-B1 byte-for-byte test, with only the runtime differing.
- No-network invariant is tier-invariant: --network none semantics re-verified under runsc, and
  the in-guest/entrypoint assertions must pass unchanged.
- Tier surfacing: /healthz + operator logs only (never the PR footer), per the M8-D2 rule.
- Measure per-review overhead vs crun and micro-VM tiers on a real review.

Done when: an end-to-end review passes on the gVisor tier on an eligible host, the ladder
selects it automatically between micro-VM and crun, and all M8 invariant tests stay green.

## Resolution

Permanently descoped per user decision on 2026-08-05. gVisor will not be implemented; this
task is closed rather than left open/deferred. The M8 isolation ladder is being collapsed
from three tiers to two: micro-VM (KVM) > hardened crun (the floor). The wired-but-empty
gVisor slot in `tier-ladder.ts` (the `Tier` union member, `TIER_RANK` entry, probe stub, and
related doc comments/error strings) is being removed alongside this closure, along with the
corresponding references in `AGENTS.md`, `INSTALL.md`, `DISTRIBUTION.md`, `PLAN.md`, and
`docs/review-flow.md`.
