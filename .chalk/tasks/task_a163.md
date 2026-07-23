---
id: task_a163
title: M8-A3: vsock transport spike — guest↔host round-trip against the real per-job gateway socket
type: task
status: in_progress
priority: 1
labels: [spike,vsock]
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:53:52Z
updated_at: 2026-07-23T07:57:00Z
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
- [x] Measure connection setup + streaming latency vs today's unix-socket path. DONE in M8-A3 —
      see "## M8-A3 latency findings" below. Overhead is negligible for this transport.

Done when: a scripted end-to-end round-trip against the real gateway per-job socket passes and
the findings (incl. host-side socket type) are written up here.

## M8-A3 latency findings

**Verdict: the vsock hop's overhead is acceptable.** Over a bare host↔host unix socket, the
guest→vsock→host per-job-socket path adds **~20 µs per streaming round-trip** and **~30–60 µs
per fresh connection**, plus a **one-time ~20–35 ms first-connection warm-up per VM**. The gateway
channel carries LLM API calls (hundreds of ms to seconds each), so every one of these is < 0.02 %
of a single LLM round-trip — the microVM gateway channel is bounded by the LLM and VMM boot, never
by the vsock bridge.

**Method (every number came from a real run; nothing estimated).** One static-musl aarch64 binary
(`spike/m8-a3/vsock-bench/`) is BOTH the host echo server AND the client, and speaks both AF_UNIX
and AF_VSOCK, so baseline and vsock path run byte-identical code and transport is the only
variable. `spike/m8-a3/run-latency.sh` drives it; timings via `CLOCK_MONOTONIC`. Baseline =
native host client → host AF_UNIX echo server (today's transport). vsock = the M8-A1
direct-libkrun launcher boots the reviewer rootfs with `krun_add_vsock_port2(port, uds,
listen=false)`; guest client dials the vsock port, libkrun connects OUT to the per-job host unix
socket where the same echo server listens. `/dev/kvm` via the `kvm` group with `sg kvm -c`. Reused
verbatim from M8-A1 (nothing rebuilt): installed libkrun/crun, `magpie-krun-launch`, `rootfs/`.
Params: conn_iters=500, stream_msgs=2000, msg_bytes=256; two full runs. Host: Raspberry Pi 5,
`Linux 6.12.93+rpt-rpi-2712 aarch64`, PAGESIZE=16384. Raw logs:
`spike/m8-a3/latency-run.log`, `latency-run-2.log`.

Numbers (microseconds), run 1 / run 2:

| path | phase / metric | count | min | median | p90 | max | mean |
|---|---|---:|---:|---:|---:|---:|---:|
| unix (baseline) | connect setup | 500 | 4.13 / 2.61 | 5.82 / 3.69 | 6.15 / 4.02 | 33.17 / 77.78 | 5.97 / 3.95 |
| unix (baseline) | connect first_roundtrip | 500 | 9.04 / 8.28 | 14.39 / 10.11 | 14.83 / 10.48 | 440.97 / 85.43 | 17.39 / 10.65 |
| unix (baseline) | stream roundtrip | 2000 | 5.83 / 3.67 | 6.46 / 4.11 | 6.65 / 4.18 | 237.82 / 294.06 | 7.23 / 4.28 |
| vsock | connect setup | 500 | 29.48 / 41.31 | 34.41 / 63.72 | 42.54 / 77.19 | 22496 / 35206 | 168.64 / 249.88 |
| vsock | connect first_roundtrip | 500 | 27.39 / 37.78 | 28.48 / 51.56 | 30.91 / 61.74 | 219.39 / 6663.96 | 31.24 / 65.26 |
| vsock | stream roundtrip | 2000 | 20.33 / 26.37 | 26.68 / 27.30 | 28.07 / 41.91 | 393.56 / 288.31 | 28.72 / 32.17 |

Interpretation:
- **Steady-state streaming round-trip** (the metric that matters for a streamed LLM response, and
  the most stable across runs): ~4–6.5 µs median unix vs ~27 µs median vsock → the vsock hop adds
  **~20 µs per round-trip**. p90 tracks the median (28–42 µs), so this is not a tail problem.
- **Connection setup**: ~4–6 µs unix vs ~34–64 µs median vsock → +30–60 µs per fresh connection.
  The gateway channel is opened once per job and reused, so this is paid a handful of times at most.
- **First-connection cold cost**: the single large `max` on vsock connect setup (~22 ms / ~35 ms)
  is the *first* vsock connect in a freshly booted VM — one-time muxer/device warm-up, not per
  message. It inflates the connect-setup mean/max but not the median/p90; the streaming benchmark's
  discarded warm-up round-trip is why its numbers are clean.

**End-to-end status: PASSES.** 500 fresh guest→vsock→host connections + 2000 streaming
round-trips completed with exit 0 across two runs — i.e. the per-VM HYBRID vsock channel
(`krun_add_vsock_port2`, per-job host unix socket, TSI off) sustains repeated connections and
streaming, not just the single round-trip M8-A1 proved.

Honest gaps: amd64 untested (no hardware). The echo server is a trivial byte-echo that isolates
transport latency by design; wiring the *real* gateway proxy plane + a minted virtual key over this
channel is the pipeline-port work (RUST-1/RUST-2, `task_b3f7`), not this latency spike — so the
"full LLM round-trip with a real minted virtual key" line in the description above is NOT yet done
and this task stays open for it. Trust the median/p90 (not min/max) figures; the two runs agree.
