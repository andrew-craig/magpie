---
id: bug_73b2
title: M8-C1 relay drops reply data on first connection(s) after startup (rust/vsock-client)
type: bug
status: open
priority: 1
labels: [vsock,rust,microvm]
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-26T23:18:56Z
updated_at: 2026-07-26T23:18:56Z
---
Found during the M8-C2 direct-wiring spike (spike/m8-c2/direct-wiring-spike.md, assertion 3b; branch m8-c2-forwarder-plan, commit 0f9ce82).

Symptom: driving back-to-back / parallel connections through the real merged guest relay 'magpie-vsock-client' (rust/vsock-client, M8-C1/task_2d6c, on main via PR #57) intermittently DROPS the reply on the relay's first 1-2 connections after process startup — the host/gateway side confirms it sent the bytes, the guest-side TCP client (Pi's position) never receives them. Reproducible; isolated to a startup/warm-up race, NOT the host-side vsock wiring (raw per-connection dials bypassing the relay were 39/39 clean; only the relay path is flaky). Half-close still propagates correctly even on the affected connections.

Suspected locus: the thread-per-direction handoff in relay() (rust/vsock-client/src/main.rs ~L275-292), specific to the first connection(s) a freshly-started relay handles after its own preflight dial. Mechanism NOT yet root-caused — could still be partly a spike-harness/Node-client timing artifact; needs instrumentation/strace to confirm before assuming the fix site.

Impact/gating: guest-side and orthogonal to the direct-wiring decision (a host-side Rust relay fallback would NOT fix it). But rust/vsock-client is exactly the binary C3 (task_39ff) makes carry live Pi<->gateway traffic, so this should be root-caused + fixed (or explicitly guarded) BEFORE C3 ships live traffic through this path. Consider gating task_39ff on this.
