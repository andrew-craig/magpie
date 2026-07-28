---
id: task_3b48
title: M8-C4: no-network-by-construction — TSI/passt built off + fail-closed in-guest assertion
type: task
status: in_progress
priority: 1
labels: [security,microvm]
blocked_by: [task_39ff]
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:55:21Z
updated_at: 2026-07-28T10:42:11Z
---
Brief §5 caveat + §7.2. libkrun's TSI/passt transport can give a guest egress with NO virtio-net
device visible in a config audit — the VMM analog of Proposal C's fail-open netns. "No network"
is therefore a mandated invariant asserted at three layers, not a launch flag:

- [ ] Construction: the reviewer VM is launched with network transport disabled (no TSI/passt,
      no virtio-net); document the exact krun knobs and pin them in the launch code.
- [ ] Install preflight: assert the launch configuration has no network transport enabled
      (pairs with the M8-D1 tier preflight).
- [ ] In-guest, fail-closed at startup: extend docker/reviewer/entrypoint.sh's existing
      confinement assertions — verify no non-lo interface, empty route table, AND an actual
      egress attempt to a known-external address fails (catches the TSI case where no interface
      exists to inspect). Abort the review on any assertion failure.
- [ ] The only permitted channel out is the vsock port to the per-job gateway socket — assert
      the allowed port explicitly.
- [ ] Negative test in CI/e2e: a deliberately mis-launched VM (TSI on) must be caught by the
      in-guest assertion.

Done when: all three layers assert and a TSI-enabled mis-launch is provably caught.

## C4 implementation plan (2026-07-28)

Studied the current state first (all on branch `m8-c2-forwarder-plan`, C3's work):
- `rust/magpie-microvm-launcher/src/krun.rs`: `boot()` already calls
  `krun_disable_implicit_vsock` then `krun_add_vsock(ctx, TSI_NO_HIJACK=0)`
  unconditionally, fail-closed ordering (no later call runs if either fails).
  No `krun_add_net_*` call exists anywhere in the crate. Confirmed against
  `/usr/local/include/libkrun.h` on this box: TSI hijack is
  `KRUN_TSI_HIJACK_INET`/`KRUN_TSI_HIJACK_UNIX` bits on `krun_add_vsock`'s
  2nd arg; a virtio-net device is a wholly separate `krun_add_net_*` family
  this crate never calls.
- `docker/reviewer/entrypoint.sh`'s M4-E network-confinement block (now
  ~lines 290-404) already runs UNCONDITIONALLY (both tiers, not gated on
  `MAGPIE_IS_MICROVM`) — canaries (`1.1.1.1:443`, `github.com:443`) +
  gateway `/healthz` reachability. It does NOT currently enumerate
  interfaces/routes, and does not explicitly assert the vsock port.
- Confirmed empirically (`docker run --network none`): only `lo` interface,
  IPv4 route table has 0 entries (header only), IPv6 route table has 2
  intrinsic lo-scoped entries (`::1/128`, `ff00::/8` via `lo`) — so an
  IPv6-route-table-non-empty check must tolerate lo-only routes, not require
  literal emptiness.
- Found (`spike/m8-a1/libkrun/src/init_blob/init/init.c`): the guest's own
  init, when the kernel cmdline carries `tsi_hijack` (i.e. TSI hijack bits
  were requested), additionally brings up a `dummy0` interface
  (administratively down). So a TSI-hijack mis-launch may show a non-lo
  interface too — a bonus signal — but the spec is right not to rely on
  this alone: the real crux is the ACTIVE egress attempt, since TSI's actual
  path is syscall interception, not a routable device.
- This box has real internet egress (confirmed `1.1.1.1:443` reachable from
  the host), so a live TSI-hijack negative test can prove REAL egress
  success, not just a plausible one.

### Layer 1 — construction (rust/magpie-microvm-launcher)
- [ ] Factor the TSI-feature decision out of `boot()` into a small pure
      `resolve_tsi_features(&LaunchConfig) -> u32` always returning
      `TSI_NO_HIJACK`, so it's unit-testable independent of any FFI call.
      Strengthen module doc / inline comments to call this the "Layer 1
      pin" for task_3b48/M8-C4.
- [ ] Unit test: construction never sets hijack bits, across multiple
      `LaunchConfig` shapes (with/without a vsock gateway) — proving the
      decision is unconditional, not just true for one fixture.
- [ ] Confirm (by inspection + a grep-shaped test if cheap) there is no
      `krun_add_net_*` call anywhere in the crate.

### Layer 2 — install/launch preflight
- [ ] `packages/orchestrator/src/reviewer.ts`: add
      `findMicrovmNetworkTransportViolations(argv)` — asserts the launch
      argv contains none of a documented disallowed-flags list (`--net`,
      `--tsi`, `--passt`, etc.) that this launcher's CLI doesn't even
      define today. Purpose: catch a FUTURE change that adds such a flag
      without revisiting this invariant. Wire it in next to
      `findMissingMicrovmFlags` at the microvm-tier call site, fail-closed
      (same pattern). Comment explicitly: "pairs with the M8-D1 tier
      preflight (task_2f46, not yet built) — this is a minimal,
      self-contained stand-in, not a replacement."
- [ ] Unit test in `reviewer-microvm-argv.test.ts`.

### Layer 3 — in-guest fail-closed assertion (docker/reviewer/entrypoint.sh)
- [ ] Add an interface-enumeration + route-table check ahead of the
      existing canary loop: no non-`lo` device under `/sys/class/net`;
      IPv4 `/proc/net/route` has zero non-header rows; IPv6
      `/proc/net/ipv6_route` has no row whose device field is anything but
      `lo`. Defense-in-depth — explicitly documented as necessary-but-not-
      sufficient (TSI needs no interface/route to hijack a syscall).
  - [x] resolved to this design after confirming empirically both facts
        above (docker --network-none baseline, and the dummy0-under-
        tsi_hijack init.c finding).
- [ ] Keep the existing active-egress canaries unchanged (they're the
      actual TSI-catching mechanism).
- [ ] Single-source the vsock port: introduce a
      `MAGPIE_EXPECTED_VSOCK_PORT` constant near the top of the script,
      pass it EXPLICITLY as `MAGPIE_VSOCK_PORT` env to `vsock-client` at
      startup (rather than relying on the binary's own implicit default),
      and assert it again (belt-and-suspenders) alongside a
      `[ -c /dev/vsock ]` re-check right after the network-confinement
      block, under `MAGPIE_IS_MICROVM` only.
- [ ] Add a clear "network confinement verified" log line once every check
      above passes, so both operators and the C4 negative-test harness have
      an unambiguous signal to grep for.
- [ ] Confirm (already true, re-verify after edits) this whole block runs
      for both tiers, unconditionally — not gated on `MAGPIE_IS_MICROVM`.

### Negative test (mandated acceptance crux)
- [ ] A TEST-ONLY way to force TSI hijack ON, kept structurally
      unreachable from the production launcher/config: a small standalone
      harness under `spike/m8-c4/` (mirroring the `spike/m8-c2` C3 e2e
      pattern) that links libkrun directly and calls
      `krun_add_vsock(ctx, KRUN_TSI_HIJACK_INET)` — NOT a flag on
      `magpie-krun-launch` itself, so there is no code path in the
      production binary that could ever be mis-set to reach this.
  - [ ] Guest side: copy the (now-updated) real
        `docker/reviewer/entrypoint.sh` into the test rootfs at
        `/opt/magpie/entrypoint.sh` so the negative test exercises the
        REAL source, not a synthetic probe. Stub just enough (fake
        `sk-magpie-*` key, `MAGPIE_REQUIRE_MEMORY_LIMIT=false`, a minimal
        host-side stub listener on the vsock-uds so the relay's own
        preflight connect succeeds, work/out mount fixtures) to reach the
        network-confinement block for real; expect it to reach `exec pi`
        (or fail on a stubbed/missing `pi`, an acceptable terminal state
        distinct from a confinement abort) on the TSI-OFF path, and to
        ABORT at the confinement block on the TSI-ON path.
- [ ] Run positive (TSI-off) and negative (TSI-on) boots on real hardware
      (`sg kvm`, arm64, 16KB pages, real `/dev/kvm`, libkrun v1.19.4) and
      record actual output.

### Verification
- [ ] `cd rust && cargo build --release && cargo test --workspace`
- [ ] `npm test` (full workspace; re-run `reviewer.test.ts` in isolation if
      the known AbortSignal flake fires)
- [ ] `git diff main -- packages/orchestrator/src/**/reviewer-crun-floor-argv.golden.json`
      must be EMPTY
- [ ] Live on-box positive + negative runs above

### Process
- [ ] Commit incrementally, `type(m8-c4): ...` messages, each ending with
      the Opus co-author trailer
- [ ] Leave `task_39ff` alone (already has its own C3 status section);
      append a "C4 status: proven vs deferred" section to THIS file
      instead of closing it
