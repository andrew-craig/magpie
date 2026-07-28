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

## C4 status: proven vs deferred (2026-07-28)

Implemented on branch `m8-c2-forwarder-plan` (NOT closed — same posture as
`task_39ff`'s C3 section: the tech lead makes the PR/close call). Commits:
- `748f7f0` plan
- `4986f20` Layer 1 — pin construction-time TSI-off in `krun.rs`
- `fb18fe3` Layer 2 — `findMicrovmNetworkTransportViolations` argv preflight
- `c83d7b1` Layer 3 — first pass at interface/route/vsock-port checks
- `9c67ead` Layer 3 fix + live negative test (found, via real boots, that the
  first pass's interface check was too strict, and that the vsock-port
  re-assertion had an env-scoping bug — both fixed and re-verified live)
- `dedc4fd` fix — the negative-test driver was clobbering a shared, gitignored
  rootfs fixture file a DIFFERENT script (`smoke-test.sh`) depends on; found
  by re-running that script after this task's own changes, fixed, and
  everything re-verified green afterward

### PROVEN (implemented + verified on this box)

**Layer 1 — construction (`rust/magpie-microvm-launcher/src/krun.rs`).**
Confirmed by inspection (this box's installed `/usr/local/include/libkrun.h`,
v1.19.4) that a virtio-net device is a wholly separate call family
(`krun_add_net_*`) this crate's `extern "C"` block never declares — there is
no code path in the binary that could attach one. Factored the TSI feature
bitmask decision out of `boot()` into a pure `resolve_tsi_features(&LaunchConfig)
-> u32`, always `TSI_NO_HIJACK` regardless of config content (no field, argv
flag, or env var anywhere in this binary/`packages/orchestrator` can move
it). Added a module doc "LAYER 1 PIN" section and 4 new unit tests (empty
config, vsock-gateway-configured, mounts-configured, and a bit-position pin
on `TSI_NO_HIJACK` itself). `cargo test -p magpie-microvm-launcher`: 69/69
(65 existing + 4 new).

**Layer 2 — install/launch preflight (`packages/orchestrator/src/reviewer.ts`).**
Added `findMicrovmNetworkTransportViolations(argv)`, wired in next to
`findMissingMicrovmFlags` at the microvm-tier spawn site, fail-closed on any
match. The launcher's CLI has no network-enabling flag today (confirmed
against `cli.rs`'s `USAGE`) so this always passes now — it's a named
regression guard for a future change, explicitly commented as pairing with
the not-yet-built M8-D1 tier preflight (`task_2f46`). 4 new unit tests in
`reviewer-microvm-argv.test.ts` (18/18 passing, up from 14).

**Layer 3 — in-guest fail-closed assertion (`docker/reviewer/entrypoint.sh`).**
Extended the existing M4-E network-confinement block (runs unconditionally,
both tiers — confirmed unchanged):
- Interface enumeration (`/sys/class/net`) + IPv4 (`/proc/net/route`) +
  IPv6 (`/proc/net/ipv6_route`, tolerating the two lo-scoped intrinsic
  routes) route-table checks, explicitly documented as defense-in-depth,
  NOT the TSI-catching mechanism.
- **Found and fixed live, not by inspection**: this box's installed libkrun
  (v1.19.4) always attaches a `dummy0` interface alongside `lo`, TSI on or
  off (already independently documented by `smoke-test.sh`'s own "dummy0 is
  administratively down" assertion — should have checked that first rather
  than reading a possibly-mismatched libkrun source snapshot). Distinguished
  the two states empirically by operstate: TSI off → `dummy0` operstate=`down`,
  no route, egress blocked; TSI on → operstate=`unknown` (up), a REAL IPv4
  route appears (libkrun's TSI-INET hijack actually DHCP-configures it), and
  raw egress genuinely succeeds (this host has real internet — confirmed).
  The interface check now tolerates `dummy0` only when administratively
  down.
- Kept the active-egress canary loop (`1.1.1.1:443`, `github.com:443`)
  unchanged — the actual TSI-catching mechanism, per the diag-probe
  evidence below.
- Single-sourced the micro-VM vsock port: `MAGPIE_EXPECTED_VSOCK_PORT=1234`
  (matches `microvm-vsock.ts`'s `MICROVM_VSOCK_PORT` / `rust/vsock-client`'s
  `DEFAULT_VSOCK_PORT`), `export`ed before starting `vsock-client` so it's
  both inherited by the child AND re-checkable later (an earlier version
  used a one-shot `VAR=value cmd &` prefix, which only sets the child's
  env — found and fixed via the live positive-control run failing).
- A "network confinement verified" log line once every check passes.
- Confirmed this whole block runs unconditionally for both tiers (not
  gated on `MAGPIE_IS_MICROVM`; only the micro-VM-specific vsock-channel
  re-assertion is tier-gated).
`bash -n`/`shellcheck -x` both clean throughout.

**Negative test — the acceptance crux (`spike/m8-c4/`).** A wholly separate,
throwaway `tsi-hijack-launch.c` (NOT the production `magpie-krun-launch`,
which has no code path to do this) mirrors `krun.rs`'s `boot()` sequence but
reads the vsock TSI feature bitmask from `MAGPIE_TSI_FEATURES` (env, default
0) — the one deliberate deviation needed to reproduce a TSI-hijack
mis-launch. `gw-stub-listener.py` is a minimal host-side gateway-shaped UDS
stub so the positive control can reach `vsock-client`'s preflight + the
entrypoint's own `/healthz` probe. `run-negative-test.sh` runs TWO phases
live via `sg kvm` (arm64, 16KB pages, real `/dev/kvm`, libkrun v1.19.4):
- **Phase 1 (`diag-probe.sh`, bypassing `entrypoint.sh`)**: independently
  characterizes TSI on/off before trusting `entrypoint.sh`'s own verdict —
  6/6 assertions PASSED, including "TSI on: raw egress connect() to
  `1.1.1.1:443` SUCCEEDS" (proves the mis-launch is genuine — real host
  internet, real guest egress via hijacking, with NO virtio-net device
  attached).
- **Phase 2 (the real, current `entrypoint.sh`, refreshed from source into
  the shared rootfs before each boot)**: 4/4 assertions PASSED — positive
  control reaches and logs "network confinement verified"; the TSI-on boot
  never reaches that line and is aborted by a Layer-3 check (the interface
  check, specifically, on this libkrun version — an acceptable and correct
  defense-in-depth catch; Phase 1 independently proves the egress-canary
  mechanism itself is also sound, for a hypothetical libkrun where TSI
  leaves no interface-level trace at all).
- **10/10 total assertions PASSED.**

**No regression on the existing production paths** (found a real one along
the way, fixed it, re-verified):
- `rust/magpie-microvm-launcher/smoke-test.sh` (production `magpie-krun-launch`,
  TSI-off, the plain smoke boot): 8/8 PASSED.
- C3's live e2e (`--out-mount`, `--env-from-host`, real vsock HTTP round-trip
  with zero byte loss over the production launcher) — recovered from git
  history (`2dfdcef`) per the earlier "strip spike harness scripts" decision,
  run, then discarded again (not re-added to the tree): 8/8 PASSED.
- `cd rust && cargo build --release && cargo test --workspace`: 69 + 14 + 5
  = 88 passed, 0 failed (up from C3's 84; the 4 new are Layer 1's).
  `cargo fmt --all -- --check`: clean.
- `npm test` (full workspace, one pass, no flake): gateway 75, orchestrator
  365 (+4 skipped, up from 361 — the 4 new are Layer 2's), review-extension
  11. `reviewer.test.ts` also re-run in isolation: 28/28 green.
- `git diff main -- packages/orchestrator/src/**/reviewer-crun-floor-argv.golden.json`:
  EMPTY.

### DEFERRED (not achievable on this box / out of C4 scope)

- **Reviewer image rebuild/republish** — `entrypoint.sh` is a SOURCE change;
  the cosign-signed multi-arch GHCR image needs a rebuild for a real
  container/micro-VM job to pick up these checks. Same deferral as C3.
- **Full webhook→published-review live pipeline under the microvm tier
  exercising THESE Layer-3 checks** — needs the republished image + M8-D3
  host provisioning; same deferral as C3.
- **amd64** — no amd64 hardware on this box.
- **M8-D1 tier preflight (`task_2f46`)** — Layer 2 here is a deliberately
  minimal, self-contained stand-in (`findMicrovmNetworkTransportViolations`)
  with an explicit TODO to be absorbed into the dedicated tier-preflight
  module once that task is built; not built here.
- **A libkrun version/config where TSI hijacking leaves literally no
  interface-level trace at all** — not reproducible on this box's installed
  libkrun (v1.19.4 empirically always surfaces a `dummy0` state change under
  TSI-INET hijack, so the interface check catches it here too). The
  Phase-1 diag-probe evidence (raw egress genuinely succeeds under hijack)
  is the basis for treating the active-egress canary as the invariant
  mechanism regardless of what any future libkrun version does to
  interfaces/routes — but a scenario where the canary is the ONLY thing
  that fires was not directly observable on this specific installed
  version.
