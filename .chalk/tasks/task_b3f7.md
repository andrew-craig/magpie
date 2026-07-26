---
id: task_b3f7
title: M8-C2: host-side per-VM vsock↔gateway forwarder
type: task
status: in_progress
priority: 1
labels: [vsock,gateway]
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:54:58Z
updated_at: 2026-07-26T22:37:33Z
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

---

## Implementation plan (drafted 2026-07-26)

### Key finding — the "forwarder" may not be a separate component at all

The task/brief were written before the direct-libkrun launcher existed (they assumed
`podman --runtime krun`, where these calls are unreachable). Now that
`rust/magpie-microvm-launcher` links libkrun directly and owns
`krun_add_vsock_port2(ctx, port, uds_path, listen=false)` (see `src/krun.rs:296-301`),
the topology is:

- `listen=false` ⇒ **libkrun is a CLIENT** — on each guest `connect(port)` it opens a fresh
  host-side unix connection to `uds_path` (per-connection, self-delimiting byte stream; proven
  in M8-A1 + `vsock-client`'s module doc). So **something must LISTEN at `uds_path`.**
- The gateway already listens at `<socketDir>/gw.sock` — an ordinary multi-accept unix server,
  **mode 0666** inside a **0711** job dir (`packages/gateway/src/job-sockets.ts`;
  config.ts:40-41). Any uid that can traverse the path can connect — including a kvm-group
  launcher uid distinct from the gateway uid.

⇒ **Point `--vsock-uds` straight at the gateway's per-job `gw.sock`.** libkrun dials it directly,
per guest connection, exactly matching the gateway's existing accept model (today's
`docker/reviewer/forwarder.mjs` already dials `gw.sock` once per TCP connection — same shape).
No separate relay process, no host-global listener, and **per-job isolation is preserved by the
per-job `gw.sock` itself** (each job's guest can only reach its own job's socket).

In this design **C2 largely dissolves into C3 (`task_39ff`)**: the "net-new forwarder" becomes
"thread `gatewayKey.socketDir + '/gw.sock'` as the launcher's `--vsock-uds`, plus a fixed
`--vsock-port`." This is a scope reduction worth confirming with the CTO, since the brief lists
the forwarder as a distinct net-new component.

### TS-vs-Rust — decision

**Neither, if direct wiring holds (preferred).** There is no discrete forwarder process to write.

**If a spike shows direct wiring is insufficient (see gate below): Rust, as a standalone helper
process — not TypeScript, and not co-located in the launcher.**
- Rust over TS: the exact relay/half-close/teardown-race logic is already written, unit-tested,
  and (once RUST-2 pipeline lands) cosign-signed in `rust/vsock-client` (`relay()` + the
  `RelayHalf` trait). A host relay is the same logic with `AF_UNIX` legs on both sides — lift
  `relay()` into a shared crate rather than reimplement in Node. Keeps the whole vsock boundary
  in one signed native toolchain instead of splitting it Node+Rust. The task's "TypeScript is
  viable" note is true but predates the signed native relay existing.
- NOT co-located in the launcher: `krun::boot`→`krun_start_enter` **never returns** (the launcher
  process *becomes* the VM), so it cannot run a post-boot accept loop. A relay would have to be a
  pre-boot background thread, which violates the launcher's "standalone, consumes prepared paths,
  owns no orchestrator plumbing" scope. A separate `magpie-vsock-host-relay` binary (listen on
  uds_path → dial gw.sock) spawned/reaped by the orchestrator per job is cleaner.

### Gate: one-shot vsock round-trip spike — DONE, PASS (2026-07-27)

Ran on this box (arm64, 16 KB pages, real `/dev/kvm` + libkrun). Full write-up +
scripts: `spike/m8-c2/direct-wiring-spike.md` (branch commit `0f9ce82`).
**VERDICT: direct wiring is viable — no separate host-side forwarder needed.**
- [x] Boot launcher `--vsock-uds`=gateway-postured `gw.sock` `--vsock-port 1234` — PASS.
- [x] Bidirectional round-trip across multiple guest connections (sequential + true parallel) —
      PASS at the raw-dial level (39/39 over 6 runs). ⚠️ Driving the SAME load through the real
      `magpie-vsock-client` relay surfaced a separate, reproducible defect (see below).
- [x] Half-close/teardown both directions — PASS.
- [x] Launcher uid connects `gw.sock` at 0666-in-0711 — PASS (exact `job-sockets.ts` posture).
- [x] Isolation: two concurrent VMs, each own `gw.sock`, cannot cross-connect — PASS (3/3).
PASS ⇒ **direct wiring confirmed**; the Rust `magpie-vsock-host-relay` fallback is NOT needed.

> **⚠️ Defect found (tracked as `bug_73b2`, P1):** the already-merged guest relay
> `rust/vsock-client` (`relay()`, ~`src/main.rs:275-292`) drops the reply on its **first 1–2
> connections after startup** under back-to-back/parallel load — host sends, guest never sees.
> Guest-side and orthogonal to this host-wiring decision (a host relay fallback would NOT fix
> it), but `rust/vsock-client` is exactly the binary **C3 (`task_39ff`)** makes carry live Pi
> traffic — root-cause/fix or guard it before C3 ships live. Mechanism not yet root-caused
> (could be partly a spike-harness artifact); needs instrumentation to confirm.

### Wiring (applies to both outcomes; mint/revoke flow UNCHANGED)

- [ ] `pipeline.ts`: keep `mintGatewayKeyFromConfig` as-is; the mint response already yields
      `gatewayKey.socketDir`. Thread `join(socketDir, "gw.sock")` + the fixed vsock port to the
      micro-VM launch path (C3's reviewer.ts) as `--vsock-uds` / `--vsock-port`, replacing the
      docker-era `gatewaySocketDir` bind-mount argument. No new secret crosses any boundary
      (CTO edit 1 uid-split invariant holds — the launcher only receives a filesystem path).
- [ ] Fixed port convention: `1234` (matches `vsock-client` `DEFAULT_VSOCK_PORT`,
      launcher smoke-test, and the guest default) — isolation is by per-VM CID/uds_path, not port.
- [ ] Lifecycle: uds_path (= gw.sock) is created by the gateway at mint time (before boot) and
      torn down at revoke (job end/timeout/crash), so ordering is already satisfied by the
      existing mint→run→revoke try/finally. If the Rust relay fallback is used instead, it must be
      spawned before boot and reaped on every exit path, and hook into `orphan-cleanup.ts`
      (→ coordinate with `task_df53` M8-C5).

### Contract / tests

- [ ] `relay-boundary.test.ts` is the GUEST-side (TCP→vsock) contract and must stay edit-free
      (RUST-3 no-edit policy). The host leg is a DIFFERENT boundary (unix→unix). Direct wiring has
      no host relay to test — coverage is the spike + a pipeline-level per-job isolation test.
- [ ] If the Rust relay fallback lands, give it its own boundary contract (sibling test +
      `cargo test`), mirroring `vsock-client`'s split (impl-agnostic behavior asserted once).
- [ ] Add/extend a pipeline test asserting two concurrent jobs get distinct socket paths and
      cannot cross-connect (the "Done when" isolation clause).

### Open questions for CTO / next session

1. Confirm the scope reduction: C2 collapsing into C3 (direct wiring) vs. keeping a discrete
   forwarder component as the brief literally specifies. **Spike now empirically supports the
   collapse (direct wiring PASS on real hardware, all 5 gate assertions).** The only remaining
   reason to build a discrete forwarder is deliberate defense-in-depth / a throttle+observability
   seam on the egress path — a policy call, not a technical necessity.
2. If a discrete component is wanted regardless (defense-in-depth / observability seam), confirm
   Rust standalone helper over TS.
3. `bug_73b2` (guest-relay first-connection data loss) — decide whether to hard-gate `task_39ff`
   (C3) on it, or let C3 proceed with the fix tracked in parallel.

### Delivered on this branch (`m8-c2-forwarder-plan`)

- Plan + investigation (this file).
- `packages/orchestrator/src/microvm-vsock.ts` + test — per-job vsock channel derivation
  (`udsPath = <socketDir>/gw.sock`, port 1234) + isolation tests. Correct under either outcome;
  consumed by C3. (commit `4c6791e`)
- `spike/m8-c2/` — the direct-wiring spike scripts + `direct-wiring-spike.md`. (commit `0f9ce82`)
