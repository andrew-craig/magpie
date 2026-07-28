---
id: bug_73b2
title: M8-C1 relay drops reply data on first connection(s) after startup (rust/vsock-client)
type: bug
status: closed
priority: 1
labels: [vsock,rust,microvm]
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-26T23:18:56Z
updated_at: 2026-07-27T02:58:57Z
---
Found during the M8-C2 direct-wiring spike (spike/m8-c2/direct-wiring-spike.md, assertion 3b; branch m8-c2-forwarder-plan, commit 0f9ce82).

Symptom: driving back-to-back / parallel connections through the real merged guest relay 'magpie-vsock-client' (rust/vsock-client, M8-C1/task_2d6c, on main via PR #57) intermittently DROPS the reply on the relay's first 1-2 connections after process startup — the host/gateway side confirms it sent the bytes, the guest-side TCP client (Pi's position) never receives them. Reproducible; isolated to a startup/warm-up race, NOT the host-side vsock wiring (raw per-connection dials bypassing the relay were 39/39 clean; only the relay path is flaky). Half-close still propagates correctly even on the affected connections.

Suspected locus: the thread-per-direction handoff in relay() (rust/vsock-client/src/main.rs ~L275-292), specific to the first connection(s) a freshly-started relay handles after its own preflight dial. Mechanism NOT yet root-caused — could still be partly a spike-harness/Node-client timing artifact; needs instrumentation/strace to confirm before assuming the fix site.

Impact/gating: guest-side and orthogonal to the direct-wiring decision (a host-side Rust relay fallback would NOT fix it). But rust/vsock-client is exactly the binary C3 (task_39ff) makes carry live Pi<->gateway traffic, so this should be root-caused + fixed (or explicitly guarded) BEFORE C3 ships live traffic through this path. Consider gating task_39ff on this.

## Root cause + fix (2026-07-27)

**Root cause: NOT a defect in `rust/vsock-client`.** It is a timing race in the direct
`--vsock-uds` bridge (libkrun's own vsock-to-unix-socket proxying, the mechanism this whole
M8-C2 spike evaluates), triggered when a peer playing the "host" role calls `shutdown(SHUT_WR)`
immediately (same tick, no gap) after `sendall()`ing its reply. `spike/m8-c2/gw-stub-listener.py`
did exactly that. The bridge's propagation of the "peer is done" teardown signal to the guest
can outrun its own forwarding of the just-sent reply bytes, so the guest's relay observes a
bare `Ok(0)` (EOF, zero bytes) instead of the reply — not an instantly-poisoned read; the
guest's blocking read on the vsock reply direction genuinely waits the full round trip and
*then* returns EOF with nothing.

**How this was proven, definitively (not guessed):**

1. Reproduced first: `spike/m8-c2/run-assertion345.sh` against the unmodified relay + unmodified
   `gw-stub-listener.py` lost the reply on 10/10 connections (all 5 sequential + all 5
   parallel), consistently, across every run on this box today — not just "the first 1-2"
   as originally suspected; that detail in the original report was itself an artifact of
   whatever timing happened to hold on the day it was filed.
2. Added temporary, per-fd, microsecond-timestamped instrumentation (`diag()` logging every
   `connect`/`dup`/`read`/`shutdown`/`close` call, thread-tagged) to `relay()` and
   `VsockStream` in `rust/vsock-client/src/main.rs`. This showed the main thread's
   `io::copy(&mut b, &mut a)` (reading the host's reply off vsock) blocks for the full
   ~110ms round trip and then returns `Ok(0)` — ruling out an instant local
   shutdown-poisons-read effect and pointing at something arriving (or failing to arrive)
   from the host side.
3. Tested two independent guest-side hypotheses/mitigations in the (temporarily modified)
   relay: (a) deferring the close of the dup'd vsock write-half fd until after the whole
   `relay()` call completes instead of dropping it as soon as the request-forwarding thread
   finishes; (b) eliminating `dup()` entirely and sharing the raw vsock fd across both
   threads instead. **Neither reliably fixed the loss** — both "helped" on some runs and not
   others, which is itself evidence the defect isn't in the relay's dup/thread/close
   ordering (a real fix there would be deterministic, not a coin flip). Both experimental
   changes were reverted; `rust/vsock-client/src/main.rs` is byte-for-byte unchanged from
   `main`.
4. Tested one host-side hypothesis instead: inserted a delay in `gw-stub-listener.py`
   *between* `sendall()` and `shutdown(SHUT_WR)` (the existing `time.sleep(0.2)` was already
   *after* shutdown/before close, and did NOT help — it's specifically the gap before
   `shutdown()` that matters). Against the **completely unmodified** `rust/vsock-client`
   relay, this eliminated the loss **reliably**: 0/10 lost replies across 7 repeated runs of
   the 5-sequential + 5-parallel batch, versus 10/10 lost on every un-delayed control run
   (2/2 control runs, matching the original 10/10 reproduction). Also re-verified clean on
   `run-diag-relay-debug.sh` (3/3 single connections, full 24-byte reply every time) and
   `run-diag-relay-delay.sh` (5/5 clean, matching its original passing shape).
5. This is consistent with why the raw one-shot direct-dial tests (assertion 3a, 39/39 clean)
   never showed the bug even against host stubs with the identical immediate-shutdown timing
   (`gw-stub-listener-oneshot-multi.py`): those clients never call `shutdown()` on their own
   vsock connection and use a single blocking read, so there's no interaction with the
   bridge's teardown-vs-flush race on that side.

**What was changed:**

- `spike/m8-c2/gw-stub-listener.py` — inserted `time.sleep(0.3)` between `sendall(reply)` and
  `conn.shutdown(socket.SHUT_WR)`, with a comment explaining why (this file). This is the
  canonical persistent, multi-accept host stub used by `run-assertion345.sh`,
  `run-diag-relay-debug.sh`, and `run-diag-relay-delay.sh`.
- `spike/m8-c2/direct-wiring-spike.md` — added a 2026-07-27 addendum correcting the
  assertion-3b attribution (it previously blamed `rust/vsock-client`; it does not).
- `rust/vsock-client/src/main.rs` — **no change**. `cargo test --workspace` (71 tests across
  the workspace) and `cargo build --release` are green, unmodified from `main`.

**Evidence (clean final runs, this box, 2026-07-27):**

```
=== assertion345 x3 ===
PASS: 5/5 sequential round-trips completed
PASS: 5/5 parallel round-trips completed
ALL ASSERTION-3/4 CHECKS PASSED
(repeated 3x, plus 4 earlier runs during the investigation itself: 7/7 clean total)

=== run-diag-relay-debug.sh ===
[data event: 24 bytes: "ACK[dbg]:MSG from conn1\n"]
[data event: 24 bytes: "ACK[dbg]:MSG from conn2\n"]
[data event: 24 bytes: "ACK[dbg]:MSG from conn3\n"]

=== run-diag-relay-delay.sh ===
M8C2-DELAYSEQ label=delayseq-0..4 reply="ACK[delay]:MSG from delayseq-N\n" saw_host_eof=true  (5/5)

=== other spike assertions re-verified unaffected ===
run-diag-oneshot-loop.sh: 8/8 PASS
run-diag-parallel-oneshot.sh: 5/5 PASS
run-assertion2-gwperms.sh: ALL ASSERTION-2 CHECKS PASSED
run-assertion5-isolation.sh: ALL ASSERTION-5 (ISOLATION) CHECKS PASSED
```

**Residual risk for C3 (`task_39ff`):** the transport-level race (not the relay) is real and
lives in the direct vsock-uds bridge (very likely libkrun's own implementation, an external
dependency of this repo, not something patchable here). Whatever plays the "host" role over
this transport must not `shutdown()`/close a connection immediately after writing its final
bytes. The real `packages/gateway` is a standard Node `http.createServer` responding via
`res.end()` — structurally much safer than this spike's tight synchronous Python stub (no
same-tick `shutdown()`/`destroy()` after writing) — but C3's own wiring/pipeline tests should
still probe this directly (e.g. reusing the `run-diag-relay-delay.sh` shape) rather than
assume Node's timing is inherently immune, since the underlying bridge behavior is outside
this repo's control.
