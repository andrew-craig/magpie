---
id: task_b3f7
title: M8-C2: host-side per-VM vsock↔gateway forwarder
type: task
status: open
priority: 1
labels: [vsock,gateway]
blocked_by: [task_a163,decision_aa2d]
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:54:58Z
updated_at: 2026-07-19T22:54:58Z
---
Net-new component from brief §6.1: bridges each job's per-VM vsock host socket to the gateway's
per-job unix socket. The budget-capped virtual-key model is unchanged.

Constraints:
- [ ] Per-VM hybrid vsock only — one host-side socket path (uds_path) per job, torn down with
      the job. NEVER a host-global vhost-vsock listener (shared CID namespace would demote the
      virtual key to the sole cross-job authenticator).
- [ ] Language per the RUST-1 decision + M8-A3 finding: with hybrid vsock the host side IS a plain
      unix socket (confirmed in M8-A1: libkrun connects out to it, muxer.rs:578), so TypeScript in
      the orchestrator/gateway reusing existing socket-lifecycle code is viable. BUT if this
      forwarder is co-located in the Rust launcher process (which links libkrun anyway), Rust is
      the natural choice — decide against the launcher design rather than defaulting to Node.
- [ ] Wire into pipeline.ts/gateway.ts: thread the per-job vsock socket path where the
      socket-dir mount path goes today; mint/revoke flow unchanged.
- [ ] Lifecycle: created before VM boot, cleaned up on job end/timeout/crash (ties into orphan
      cleanup task).

Done when: a review job's LLM traffic flows guest→vsock→forwarder→gateway per-job socket with
per-job isolation verified (two concurrent jobs cannot cross-connect).
