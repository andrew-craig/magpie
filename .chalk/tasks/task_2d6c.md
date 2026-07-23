---
id: task_2d6c
title: M8-C1: guest-side vsock client — static Rust binary in the signed reviewer image (replaces forwarder.mjs)
type: task
status: open
priority: 1
labels: [rust,vsock,supply-chain]
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:54:48Z
updated_at: 2026-07-23T08:29:25Z
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
- [ ] Rust binary: listens on the guest loopback TCP port Pi already targets, relays to AF_VSOCK
      toward the host-side per-job socket. Same observable contract as forwarder.mjs (Pi config
      unchanged). Start from the spike prototype.
- [ ] Static musl build (`aarch64`/`x86_64-unknown-linux-musl`) for amd64+arm64 via RUST-2; baked
      into the reviewer image build so the image digest pin + cosign signature covers it.
- [ ] Fail-closed behavior: refuse to start (and exit the entrypoint) if the vsock device is
      absent or the expected port doesn't connect — consistent with the entrypoint's existing
      confinement-assertion pattern.
- [ ] Unit tests in Rust for framing/relay; boundary behavior covered by the RUST-3 contract suite
      (existing forwarder tests run against the new binary where applicable).
- [ ] Remove forwarder.mjs from the image in the same PR (no dual path lingering).

Done when: reviewer image ships the signed Rust client, an end-to-end guest→gateway LLM call works
through it, and forwarder.mjs is gone.
