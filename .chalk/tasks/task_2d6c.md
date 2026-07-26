---
id: task_2d6c
title: M8-C1: guest-side vsock client — static Rust binary in the signed reviewer image (replaces forwarder.mjs)
type: task
status: in_progress
priority: 1
labels: [rust,vsock,supply-chain]
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:54:48Z
updated_at: 2026-07-26T02:27:30Z
---
CTO edit 4: the guest-side vsock client is a named, owned deliverable — a static Rust binary
(language per RUST-1 / `decision_aa2d`), built in our CI (RUST-2 pipeline), covered by the same
cosign signing as the reviewer image. It replaces docker/reviewer/forwarder.mjs (today's TCP→unix
relay) inside the guest.

The core mechanism is already de-risked: the M8-A1 spike built a static musl Rust `AF_VSOCK`
client (389 KB, fully static, `libc` crate only) and did a full guest↔host round-trip through
`krun_add_vsock_port2` with TSI off (`spike/m8-a1/vsock-client/`, commit `f47eaf3`). This task
turns that prototype into the real relay.

Plan:
- [x] Rust binary: listens on the guest loopback TCP port Pi already targets, relays to AF_VSOCK
      toward the host-side per-job socket. Same observable contract as forwarder.mjs (Pi config
      unchanged). Start from the spike prototype.
- [x] Static musl build (`aarch64`/`x86_64-unknown-linux-musl`) for amd64+arm64 via RUST-2; baked
      into the reviewer image build so the image digest pin + cosign signature covers it. (aarch64
      built + verified statically linked, both standalone and baked into the image via a new
      Dockerfile builder stage; x86_64 cross-build not possible on this arm64 dev host -- CI builds
      it natively per rust.yml's existing per-arch-runner design, same as every other crate here.)
- [x] Fail-closed behavior: refuse to start (and exit the entrypoint) if the vsock device is
      absent or the expected port doesn't connect — consistent with the entrypoint's existing
      confinement-assertion pattern.
- [x] Unit tests in Rust for framing/relay; boundary behavior covered by the RUST-3 contract suite
      (existing forwarder tests run against the new binary where applicable).
- [ ] Remove forwarder.mjs from the image in the same PR (no dual path lingering). **NOT DONE —
      see "Design-tension finding" below: the docker/crun path forwarder.mjs serves is still the
      only live path in production, so removing it now would break Magpie with no replacement.
      Kept intentionally; entrypoint.sh now selects the correct relay at runtime instead. Actual
      removal is follow-up work once task_b3f7 (M8-C2) + the launcher/pipeline integration land
      and the docker/crun path is retired.**

Done when: reviewer image ships the signed Rust client, an end-to-end guest→gateway LLM call works
through it, and forwarder.mjs is gone.

## Implementation plan (this session)

**Design-tension finding (investigated before writing code):** `packages/orchestrator/src/
reviewer.ts` still `docker run`s the container with the bind-mounted `/run/gw/gw.sock` unix
socket and `--network none` — that is the ONLY live path today. The libkrun launcher
(`magpie-microvm-launcher`, task_76d6/M8-C0) is a standalone binary, not wired into the
orchestrator; the host-side vsock↔gateway forwarder (task_b3f7/M8-C2) doesn't exist yet. So
`docker/reviewer/entrypoint.sh`'s `forwarder.mjs` invocation is load-bearing for every review
Magpie runs in production right now. Deleting it in this PR, per the task's literal last
checkbox, would break the only working path with no replacement (there is no host-side vsock
listener for the new guest binary to even dial in the docker/crun world). **Decision: keep both
binaries in the image; `entrypoint.sh` selects at runtime based on `/dev/vsock` presence** — a
plain container has no such device, a libkrun guest always does (attached unconditionally by
`krun_add_vsock`), so this is a correct, zero-config signal requiring no new env var. Documented
inline in entrypoint.sh and Dockerfile. Actual removal of forwarder.mjs is follow-up work tied to
task_b3f7 (C2) + the pipeline/launcher integration task (task_39ff) once the vsock path is
live end-to-end and the docker/crun path is retired.

- [x] Investigate live-path dependency on forwarder.mjs; record the keep-both decision above.
- [x] Implement real `rust/vsock-client/src/main.rs`: AF_VSOCK relay (listens 127.0.0.1:4000,
      dials `VMADDR_CID_HOST` on a configurable port — `MAGPIE_VSOCK_PORT` env var / optional
      argv[1], default 1234 matching the launcher smoke-test convention), bidirectional relay
      per accepted TCP connection (thread + `io::copy`, half-close via `shutdown`), retry/backoff
      on vsock connect mirroring `forwarder.mjs`'s `dialUnixWithRetry`.
- [x] Fail-closed startup: refuse to start (exit non-zero) if `/dev/vsock` is absent, or if a
      bounded-retry preflight connect to the configured vsock port never succeeds.
- [x] Unit tests: retry/backoff loop, char-device-presence check (parameterized by path, no real
      vsock hardware needed), env/argv port parsing, and the relay copy+half-close logic
      exercised over a loopback TCP pair standing in for the tcp/vsock legs.
- [x] `docker/reviewer/Dockerfile`: multi-stage build compiling `magpie-vsock-client` (pinned,
      digest-pinned `rust:1.97.1-alpine` builder) and baking the static binary in alongside
      `forwarder.mjs` (both kept — see decision above).
- [x] `docker/reviewer/entrypoint.sh`: branch on `/dev/vsock` to start the vsock client or
      `forwarder.mjs`; rest of the readiness wait-loop / gateway healthz probe is unchanged
      (transport-agnostic, already just polls TCP 4000).
- [x] Drop the now-inaccurate `vsock-framing` dependency from `vsock-client`'s Cargo.toml (the
      relay is a raw byte pipe, like `forwarder.mjs` — framing Pi's self-delimiting HTTP traffic
      would need host-side (`task_b3f7`) decode support that doesn't exist yet, and isn't needed
      for a 1:1 TCP-connection↔vsock-connection relay); correct `vsock-framing`'s stale doc
      comment that claimed this crate would consume it.
- [x] `cargo build`/`cargo test`/`cargo fmt --check`/`cargo clippy -D warnings` all pass locally
      for the whole non-launcher workspace (mirrors rust.yml's `lint` job exactly). Built
      `aarch64-unknown-linux-musl` --release and confirmed `file` reports "statically linked"
      (matches rust.yml's `build` job's verification step). `x86_64-unknown-linux-musl` cross-build
      fails on this arm64 host (no cross-linker) — expected per rust.yml's own documented
      rationale for building each arch natively in CI; NOT verified locally, will build on CI's
      `ubuntu-24.04` runner same as the pre-existing scaffold did. Also built the full
      `docker/reviewer` image locally (multi-stage, new `vsock-builder` stage) and confirmed:
      the baked `/opt/magpie/vsock-client` is present, executable, statically linked; it fails
      closed with the expected message when `/dev/vsock` is absent (the plain-container case);
      and entrypoint.sh's `[ -c /dev/vsock ]` branch correctly selects `forwarder.mjs` in that
      same case (i.e. the live docker/crun path is unchanged). NOT verified: an actual
      guest↔host round-trip through a booted micro-VM (needs task_b3f7/C2 + KVM hardware; out of
      this task's scope per the "keep both" decision above).
- [ ] Close task_2d6c on this branch (chalk close + commit the file move).
