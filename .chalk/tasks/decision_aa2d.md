---
id: decision_aa2d
title: RUST-1: decision — Rust migration scope beyond the vsock client, and the strangler/test strategy
type: decision
status: open
priority: 1
labels: [rust,decision]
blocked_by: []
parent: epic_6955
remote_task_url: null
created_at: 2026-07-19T22:54:20Z
updated_at: 2026-07-21T21:32:05Z
---
Ratify (with CTO visibility, since they asked) the answer to: "As we need a native language for
the vsock client, what other code should be migrated, and in which language? How do we manage the
migration and leverage the tests we have?"

**Language: Rust (resolved on evidence, was open Go-vs-Rust).** The CTO mandate allowed "static Go
(or Rust)"; the M8-A1 spike settled it in favour of Rust and this decision adopts that. Two
findings drive it (see `epic_6955` and `spike/m8-a1/frontend-investigation.md`, commits `f47eaf3`
/ `823a4dd`): (a) the net-new host-side launcher must FFI libkrun's C ABI with a non-returning
entry point — hostile to Go/cgo, natural in Rust/C, and Rust over C for memory safety on a
privileged process; (b) the guest-side client was *proven* as a static musl Rust binary doing a
full vsock round-trip. Once Rust is required host-side, a second native language for the guest
client is pure toolchain tax. **Staffing caveat for the CTO:** if the team lacks Rust, the guest
client *only* may fall back to Go — but the launcher stays Rust/C, never Go+cgo.

**Scope — Rust where Node is the wrong tool, at process boundaries only:**
1. Guest-side vsock client (mandated — static Rust binary in the signed reviewer image). **Proven
   in the spike.**
2. Host-side micro-VM launcher (net-new from M8-A1): links libkrun, sets `krun_add_vsock(ctx,0)`
   (no-network), `krun_add_vsock_port2` (gateway channel), `krun_setuid`, `krun_set_vm_config`.
   The FFI component. **Needs its own task under `epic_59b1`.**
3. Install-time KVM/tier preflight probe (open /dev/kvm + KVM_CREATE_VM ioctl; raw ioctls need a
   native addon in Node, and the installer preflight must run before Node is provisioned).
4. Host-side vsock↔gateway forwarder — with hybrid-vsock the host side is a plain unix socket Node
   *could* serve, but if co-located with the launcher process it is Rust too. Decide in `task_b3f7`.
5. Candidate, not this round: the reviewer entrypoint's fail-closed confinement assertions as a
   static binary (today shell) — more robust in a minimal guest.

**Non-scope — stays TypeScript:** orchestrator business logic (webhook/HMAC, queue, GitHub App
auth, workspace/diff, findings/anchoring, publisher/rereview) and the gateway. Mature, tested,
Octokit-dependent; a rewrite is regression risk with no isolation gain — these are trusted
host-side processes in every design. Gateway-in-Rust is the only plausible future candidate
(static-binary deployment win); explicitly deferred as its own future decision.

**Migration management — strangler at process boundaries:** every Rust component is a separate
binary with a narrow contract (argv/env/exit codes, sockets, NDJSON) — no in-process rewrites of
the TS logic. (Nuance vs the original "no FFI" rule: the launcher *does* link libkrun's C ABI, but
it is a standalone native binary linking a C library, not FFI into the Node process — the
boundary rule is intact.) The existing TS integration/e2e tests exercise the pipeline THROUGH
those boundaries, so they serve unchanged as the cross-language contract harness; a Node→Rust swap
must keep them green. Rust unit tests cover Rust-internal logic only; golden fixtures (e.g. the
M8-B1 flag test) pin cross-language behavior.

- [ ] Circulate this scope (incl. to the CTO, answering their question + the Go→Rust reversal with
      the spike evidence) and record the outcome.
- [ ] Land a short docs/design/rust-adoption.md capturing scope, non-scope, and the boundary rule.
- [x] Open the host-side launcher task under `epic_59b1` (scope item 2). → `task_76d6` (M8-C0).

Done when: scope is ratified and documented; downstream Rust tasks proceed against it.
