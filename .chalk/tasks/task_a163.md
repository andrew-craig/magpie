---
id: task_a163
title: M8-A3: vsock transport spike — guest↔host round-trip against the real per-job gateway socket
type: task
status: open
priority: 1
labels: [spike,vsock]
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:53:52Z
updated_at: 2026-07-22T12:57:52Z
---
Brief §8 phase 2. Prove the gateway channel shape on the chosen VMM before porting the pipeline:
guest → vsock → host-side per-job socket → gateway proxy plane, full LLM request/response
round-trip with a real minted virtual key.

Constraints (brief §6.1, mandated):
- [ ] Per-VM HYBRID vsock — each job's VM gets its own host-side socket path (uds_path). Never a
      host-global vhost-vsock listener (shared CID namespace would make the virtual key the sole
      cross-job authenticator).
- [x] Confirm what the host side of the chosen VMM's vsock actually is (unix socket?) — feeds the
      RUST-1 language decision. DONE in M8-A1: with `krun_add_vsock_port2` the host side is a plain
      UNIX socket that libkrun connects OUT to when the guest dials the vsock port (muxer.rs:578).
- [x] Guest side exercised with a throwaway AF_VSOCK client — DONE in M8-A1, and in **Rust** (not
      Go): static musl client did a full guest↔host round-trip (`spike/m8-a1/vsock-client/`, commit
      `f47eaf3`). Informs the real guest-client task (`task_2d6c`).
- [ ] Measure connection setup + streaming latency vs today's unix-socket path. (Round-trip works;
      latency not yet measured — the remaining open item here.)

Done when: a scripted end-to-end round-trip against the real gateway per-job socket passes and
the findings (incl. host-side socket type) are written up here.
