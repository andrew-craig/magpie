
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
