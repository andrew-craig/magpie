---
id: task_0f51
title: M6-E: magpie-shim containerisation design (Proposal A) — retired by CTO decision
type: task
status: closed
priority: 2
labels: [design, retired]
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-07-17T00:00:00Z
updated_at: 2026-07-19T22:56:42Z
---
(Frontmatter reconstructed 2026-07-19 — it was lost in commit 41410ab; created_at is
approximate.)

## Outcome (2026-07-17)

Design doc `docs/design/shim-containerisation.md` delivered on branch `m6e-shim-design`.
Tech-lead reviewed = strong (four-verb contract, identical-path bind mounts, shared-netns
mgmt plane, Phase-1-closes-M6-E-with-zero-hardening-change). CTO endorsed the direction.

Decisions locked:
- 3b (root-socket shim) primary; 3a (rootless) optional v2.
- Phase 1 (shim-only, native) ships independently as the M6-E fix; Phase 2 (containerise) on top.
- Shim = small Go/Rust static binary (Go-vs-Rust deferred to spike).

Design pushed for broader review: **PR #40**. Next steps once PR lands: (1) small spike on
SO_PEERCRED/RPC ergonomics; (2) Phase-1 shim implementation task; (3) Phase-2 containerisation
as its own tracked epic. Not started (design-first, per CTO).

## Retired (2026-07-19)

The CTO's decision on docs/design/cto-decision-brief.md (decision 1) retires the M6-E shim
direction (Proposal A) as the mid-term target: the shim's root-equivalent launcher and root
Docker daemon are exactly the permanent privileged footprint the approved rootless synthesis
removes. The design doc remains as the record of the explored alternative; no shim
implementation tasks will be created. Successor work: epic_59b1 (Milestone 8 — rootless
micro-VM reviewer sandbox).
