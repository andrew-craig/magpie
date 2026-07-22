# Design: Rust adoption — native components, build/signing, migration rule

**Status:** Ratified by CTO 2026-07-22 (see `decision_aa2d` / RUST-1) — Rust adopted at the
recommended scope; staffing confirmed not a constraint, so the Go fallback below is moot.
**Author:** Claude
**Date:** July 2026
**Tracks:** `epic_6955` (Rust adoption), `epic_59b1` (Milestone 8 — rootless micro-VM sandbox)

## Summary

Magpie is TypeScript/Node on the host (orchestrator + gateway) plus a containerised reviewer. M8
introduces work Node cannot do: `AF_VSOCK` I/O inside the reviewer VM, and driving libkrun's C ABI
to launch that VM. This doc fixes **which components become native code, in which language, and how
we manage the migration without throwing away the existing TypeScript test suite.**

The language is **Rust**. The CTO mandate allowed a static "Go (or Rust)" binary for the guest-side
vsock client; the M8-A1 spike resolved that open choice in favour of Rust on evidence (below). The
net result is a **TS + Rust** two-language stack — not TS + Go + Rust.

## Why Rust, not Go

The M8-A1 spike (`.chalk/tasks/task_1fdc.md`, `spike/m8-a1/frontend-investigation.md`) surfaced a
component that wasn't in the original plan and settled the language question:

1. **The host-side micro-VM launcher forces it.** Adopting the direct-libkrun front-end (the only
   way to get provable no-network — see below) means *we* call libkrun's C ABI:
   `krun_add_vsock(ctx, 0)`, `krun_add_vsock_port2`, `krun_setuid`, `krun_set_vm_config`. That is
   FFI into a C library whose entry point `krun_start_enter` does not return — hostile to Go's
   runtime, and cgo would negate Go's static-binary and cross-compile advantages. Rust binds the
   C ABI cleanly, is memory-safe for a privileged process, and matches libkrun's own language if we
   ever need to patch it. C was the only other real candidate; Rust wins on memory safety.
2. **The guest-side client is proven in Rust.** A static musl `AF_VSOCK` client (389 KB, fully
   static, `libc` crate only) did a full guest↔host vsock round-trip through `krun_add_vsock_port2`
   with TSI off (spike commit `f47eaf3`, `spike/m8-a1/vsock-client/`). It meets every requirement
   the Go mandate was written for.

Once Rust is required host-side for the launcher, running a *second* native language for a simple
socket-forwarding guest binary is pure toolchain tax. Fewer signed-artifact toolchains and one
cross-compile/supply-chain lane is itself a security argument for an isolation product.

**Staffing fallback (resolved):** the fallback below was raised for the CTO in case the team
lacked Rust fluency — the *guest client only* would fall back to Go, launcher always staying
Rust/C. At ratification (2026-07-22) the CTO confirmed staffing is not a constraint, so **this
fallback is retired: all in-scope native components are Rust.**

## Scope — Rust where Node is the wrong tool, at process boundaries only

1. **Guest-side vsock client** (mandated). Static Rust binary in the signed reviewer image; relays
   Pi's loopback TCP to `AF_VSOCK` toward the host per-job gateway socket. Replaces
   `docker/reviewer/forwarder.mjs`. Prototype proven in the spike. → `task_2d6c` (M8-C1).
2. **Host-side micro-VM launcher** (net-new). Links libkrun; sets `krun_add_vsock(ctx,0)`
   (no-network), `krun_add_vsock_port2` (per-VM gateway channel), `krun_setuid`,
   `krun_set_vm_config`. Spawned by the orchestrator where `docker run` is today. → `task_76d6`
   (M8-C0).
3. **Install-time KVM/tier preflight probe.** Opens `/dev/kvm` + issues `KVM_CREATE_VM` (raw ioctls
   need a native addon in Node, and the installer runs before Node is provisioned). → `task_2f46`.
4. **Host-side per-VM vsock↔gateway forwarder** — with hybrid vsock the host side is a plain unix
   socket Node *could* serve, but if co-located in the launcher process (which links libkrun) it is
   Rust too. Decide against the launcher design. → `task_b3f7`.
5. **Candidate, not this round:** the reviewer entrypoint's fail-closed confinement assertions as a
   static binary (today shell) — more robust in a minimal guest.

## Non-scope — stays TypeScript

Orchestrator business logic (webhook/HMAC verify, queue, GitHub App auth, workspace/diff,
findings/anchoring, publisher/rereview) and the gateway. It is mature, tested, Octokit-dependent
TypeScript; a rewrite adds regression risk with zero isolation gain — these are trusted host-side
processes in every design. **Gateway-in-Rust** is the only plausible longer-term candidate (small
proxy, static-binary deployment win) and is explicitly deferred to its own future decision.

## Migration rule — strangler at process boundaries

Every Rust component is a **separate binary with a narrow contract** (argv/env/exit codes, sockets,
NDJSON) — never an in-process rewrite of TypeScript logic.

- **Nuance on "no FFI".** The launcher *does* link libkrun's C ABI. That is a standalone native
  binary linking a C library, **not** FFI into the Node process — the process-boundary rule is
  intact. The prohibition is on mixing languages *inside one process*, not on a Rust binary using a
  C library.
- The existing **TypeScript integration/e2e tests exercise the pipeline *through* those process
  boundaries**, so they are the cross-language contract harness and keep working unchanged when a
  Node piece is swapped for a Rust binary.
- **A migration PR may add Rust unit tests but must not modify the boundary contract tests.**
  Editing a boundary test in a swap PR is a red flag by policy. Rust unit tests cover
  Rust-internal logic only; golden fixtures (e.g. the M8-B1 floor-invariant flag test) pin
  behaviour across the swap. → `task_9d2b` (RUST-3).

## Build & signing

- **One cargo workspace** (`rust/` at repo root, alongside the npm workspaces); shared crates for
  vsock framing and confinement assertions; `Cargo.lock` committed; pinned toolchain
  (`rust-toolchain.toml`).
- **Reproducible static builds** targeting `{aarch64,x86_64}-unknown-linux-musl` for amd64+arm64.
  The guest client is fully static musl (proven). The libkrun-linking launcher may not be fully
  static — decide its link mode in the pipeline task.
- **Signing:** binaries baked into the reviewer image are covered by the image digest pin + cosign
  signature; any binary shipped outside the image (e.g. the preflight probe in the host tarball) is
  additionally cosign-signed. No pre-built third-party binaries fetched at build time — everything
  compiled from pinned sources in CI. `cargo clippy` + `cargo fmt --check` gate alongside the TS
  lint/test jobs. → `task_2a18` (RUST-2).

## Open items

- ~~CTO ratification of this scope (`decision_aa2d`), including the Go→Rust reversal and the
  staffing fallback.~~ **Ratified 2026-07-22** at the recommended scope; staffing not a
  constraint (Go fallback retired).
- Launcher link mode (fully static vs dynamically linking libkrun) and the OCI-image→rootfs prep
  path (podman `export`→virtiofs vs `krun_set_root_disk` ext4) — both in `task_76d6` / `task_08ec`.
