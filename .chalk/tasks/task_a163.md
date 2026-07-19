---
id: task_a163
title: M8-A3: vsock transport spike — guest↔host round-trip against the real per-job gateway socket
type: task
status: open
priority: 1
labels: [spike,vsock]
blocked_by: [task_1fdc]
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:53:52Z
updated_at: 2026-07-19T22:53:52Z
---
Brief §8 phase 2. Prove the gateway channel shape on the chosen VMM before porting the pipeline:
guest → vsock → host-side per-job socket → gateway proxy plane, full LLM request/response
round-trip with a real minted virtual key.

Constraints (brief §6.1, mandated):
- [ ] Per-VM HYBRID vsock — each job's VM gets its own host-side socket path (uds_path). Never a
      host-global vhost-vsock listener (shared CID namespace would make the virtual key the sole
      cross-job authenticator).
- [ ] Confirm what the host side of the chosen VMM's vsock actually is (unix socket?) — this
      decides whether the host-side forwarder can stay in Node or needs Go (feeds the Go
      migration scope decision).
- [ ] Guest side exercised with a throwaway AF_VSOCK client (Go) — informs the real guest-client
      task.
- [ ] Measure connection setup + streaming latency vs today's unix-socket path.

Done when: a scripted end-to-end round-trip against the real gateway per-job socket passes and
the findings (incl. host-side socket type) are written up here.
