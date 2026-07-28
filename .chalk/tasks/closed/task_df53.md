---
id: task_df53
title: M8-C5: orphan cleanup — reap VM/podman processes instead of docker kill targets
type: task
status: closed
priority: 2
labels: [microvm,reliability]
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:55:29Z
updated_at: 2026-07-28T12:19:50Z
---
orphan-cleanup.ts today reaps orphaned review containers via the docker CLI. Under the new
substrate the orphan population changes: rootless podman containers (crun tier) and krun VM
processes + their per-job vsock sockets and virtiofs daemons (micro-VM tier).

- [ ] Enumerate + kill orphaned podman containers by the existing per-job naming convention.
- [ ] Reap orphaned krun/VMM processes and stale per-job uds_path sockets after crash/restart.
- [ ] Ensure gateway virtual keys for reaped jobs are revoked (existing cleanup contract).
- [ ] Test: kill -9 the orchestrator mid-review; on restart everything is reaped and the next
      review runs clean.

Done when: post-crash restart leaves no orphaned VM/container/socket and the reap is covered by
a test.

## C5 implementation plan (2026-07-28)

Working directly on `m8-c2-forwarder-plan` (stacks on C3/`task_39ff` + C4/`task_3b48`, already on
this branch). No new branch, no push, no PR — tech lead makes that call.

### 0. Orphan-population audit (verify before coding — task text is stale)

- [x] Confirm the direct-libkrun launcher does virtiofs **in-process** (`krun_add_virtiofs3` FFI
      call in `rust/magpie-microvm-launcher/src/krun.rs`) — grepped the whole crate for
      `Command::new`/`spawn`/`virtiofsd`: none. **No separate virtiofsd daemon exists to reap.**
- [x] Confirm the launcher creates **no per-job socket of its own** — `microvm-vsock.ts`'s
      `microvmVsockChannel` points `--vsock-uds` straight at the GATEWAY's already-bound
      `<socketDir>/gw.sock` (`krun_add_vsock_port2(..., listen=false)` makes libkrun a CLIENT that
      dials out). The gateway (a separate process/systemd unit, `packages/gateway`) owns that
      socket's lifecycle (`job-sockets.ts` bind/teardown on mint/revoke) — nothing for the
      orchestrator's orphan-cleanup to reap here directly.
- [x] Confirm the launcher process IS the VM: `krun.rs`'s `boot()` returns `Result<Infallible,
      BootError>` — `krun_start_enter` never returns once the guest boots; the launcher never
      forks/execs a child. So one `magpie-krun-launch` PID == one live micro-VM, for its whole
      life. Killing that PID tears the guest down (per the module's own existing doc comment in
      reviewer.ts's "Micro-VM tier" section).
- [x] Confirm the crun/podman container reap (`ps -aq --filter name=magpie-` + `rm -f`) needs no
      change — still byte-identical under rootless podman (already documented in the module).
- [x] Confirm the new scratch-dir surface: `container-mounts.ts`'s `createOutputDir` makes
      `magpie-out-*` `mkdtemp` dirs directly under `config.workspace.workDir`, and `workspace.ts`'s
      `createWorkspace` makes `<owner>-<repo>-<prNumber>-<headSha>` dirs in the SAME directory —
      confirmed (grep) these two call sites are the ONLY writers into `workspace.workDir` anywhere
      in the orchestrator, so at startup (before any job is enqueued) every entry directly under
      that directory is, by construction, orphaned scratch from a job that never got to clean up.

**Corrected orphan population for this task:**
1. Podman/docker containers (crun tier) — unchanged, already handled.
2. Orphaned `magpie-krun-launch` processes (microvm tier) — NEW.
3. Orphaned per-job scratch dirs under `config.workspace.workDir` (`magpie-out-*` AND workspace
   checkout dirs) — NEW, applies to BOTH tiers (workspace dirs are tier-agnostic; `magpie-out-*`
   is too, since `createOutputDir` is shared code).
4. Gateway virtual keys — design fork, see §4 below; NOT a new reap target on the orchestrator
   side (see justification).

### 1. `magpie-krun-launch` process reap

- [x] Add `cleanupOrphanLauncherProcesses(config, listProcessesFn, killFn, logger)` to
      `orphan-cleanup.ts`. Enumerate via an injectable `ps -eo pid=,args=` call (execFile, no
      shell), match each line's first whitespace-separated token's `basename()` against
      `basename(config.microvm.launcherBin)`, kill every match with `SIGKILL` via an injectable
      kill function (defaults to `process.kill`, no `kill` binary spawn needed).
- [x] Gate on `config.container.tier === "microvm"` — on a crun-only deployment, skip the `ps`
      call entirely (matches the task's explicit instruction; also sidesteps any host where `ps`
      might not be on PATH but microvm is never used).
- [x] Safe-to-reap-all justification (inline comment): this runs at startup, before the queue
      accepts any job, so there are no in-flight launcher processes to avoid — same "reap
      everything named `magpie-*`" model `cleanupOrphanContainers` already uses.
- [x] Best-effort/never-throws, mirroring the existing module exactly (`ps` missing/erroring,
      or a kill on an already-dead pid (ESRCH), is logged and swallowed).

### 2. Orphaned scratch-dir reap

- [x] Add `cleanupOrphanScratchDirs(config, listDirFn, rmFn, logger)` to `orphan-cleanup.ts`.
      `readdir(config.workspace.workDir)` (best-effort — ENOENT on a not-yet-created dir is a
      silent zero-count success, not an error) and `rm(entry, { recursive: true, force: true })`
      every entry found directly under it.
- [x] Injectable `listDirFn`/`rmFn` (default real `fs.readdir`/`fs.rm`) so the test suite never
      touches the real filesystem outside a throwaway tmp dir.
- [x] Path-join only from `readdir`-returned names (never from any external/attacker input) and
      only under the configured `workspace.workDir`, so there's no traversal surface.
- [x] Best-effort/never-throws, same contract as the rest of the module.

### 3. Wire into `index.ts`

- [x] Call all three cleanup functions (containers, launcher processes, scratch dirs) from the
      same startup spot `cleanupOrphanContainers` already occupies (index.ts:129), before the
      queue/server are constructed. Each is independently best-effort, so one failing must not
      skip the others.

### 4. Gateway virtual-key design fork — DECIDE (b), document why

The admin plane has mint (`POST /admin/keys`) and revoke-by-id (`DELETE /admin/keys/:id`) but no
list-all/bulk-revoke endpoint, and after a `kill -9` the orchestrator has no in-memory record of
which job ids were live to revoke.

**Decision: (b) — document that this is already covered, add NO new gateway endpoint.**
Justification (to write inline in orphan-cleanup.ts and here):
- The gateway is a **separate process** (own systemd unit, `packages/gateway`). Killing the
  orchestrator does NOT kill the gateway or clear its in-memory `KeyStore`/`JobSocketManager` —
  so an orphaned launcher's key/socket are still exactly as valid/invalid after the orchestrator
  crash as they were before it. There is nothing new to revoke as a *consequence of the
  orchestrator's own crash*.
- Once step 1 above kills the orphaned launcher process, the guest (and thus the ONLY thing that
  could ever present that job's virtual key over the vsock channel) is gone. A revoked-vs-not
  key with no VM left alive to use it has no remaining attack surface — killing the launcher is
  the operative control, not the gateway-side bookkeeping.
- Defense in depth already exists independent of any of this: `KeyStore.mint`/`findByKey` are
  TTL-capped (`expiresAt`, lazily evicted) AND budget-capped (`isOverBudget`) — see keystore.ts.
  A key nobody is actively revoking is bounded in both how long and how much it can spend, by
  construction, before this task existed.
- Precedent: this is the exact same shape the crun tier has had since M3-D — `cleanupOrphanContainers`
  has never called the gateway to revoke a reaped container's key either, and that gap was never
  flagged as a bug. Adding a bulk-revoke admin endpoint now would be new cross-process surface for
  a scenario that's already fully bounded by TTL+budget, i.e. the smaller-and-correct option per
  the task's own steer.
- [x] Write this reasoning as a doc comment in `orphan-cleanup.ts` (not just this task file).

### 5. Tests

- [x] `orphan-cleanup.test.ts`: new `describe` blocks for
      `cleanupOrphanLauncherProcesses` (crun tier no-ops without calling `ps`; microvm tier lists
      + kills every matching pid; ignores non-matching processes; swallows a `ps`/kill error) and
      `cleanupOrphanScratchDirs` (empty dir → zero removals; several `magpie-out-*` + workspace-shaped
      dirs → all removed; missing dir (ENOENT) → zero removals, no throw; a removal error is
      swallowed and logged).
- [x] A combined "crash-restart reap" test exercising all three (containers + processes + scratch
      dirs) together with injected fakes, asserting the gateway-key non-action is a documented,
      deliberate no-op (not simply untested) — e.g. a comment/assertion that no gateway client is
      constructed/called anywhere in this module.
- [x] Time-permitting on-box (`sg kvm`, reusing `spike/m8-a1/rootfs` + the built
      `rust/target/release/magpie-krun-launch`): boot a real launcher, kill its PARENT (or the
      launcher itself, simulating `kill -9` of a process tree) leaving the launcher/VM running,
      then run `cleanupOrphanLauncherProcesses` for real and confirm the PID is gone
      (`kill -0` fails after). If this isn't cleanly achievable non-interactively, defer explicitly
      — same posture as C3/C4's live e2e deferrals.

### 6. Verification

- [x] `npm test` (full workspace); re-run `reviewer.test.ts` in isolation if the known-flaky
      AbortSignal test flakes.
- [x] `git diff main -- '*reviewer-crun-floor-argv.golden.json'` must be EMPTY (no touches to the
      crun path expected from this task at all).
- [x] No Rust changes expected for this task; skip the cargo step unless something forces one.

### 7. Process

- [x] Commit incrementally, `chore/feat/test(m8-c5): ...`, trailer `Co-Authored-By: Claude Opus
      4.8 <noreply@anthropic.com>`.
- [x] Leave `task_df53` `in_progress`; append a "C5 status: proven vs deferred" section instead of
      closing (tech lead makes the PR/close call, same as C3/C4 on this same branch).

## C5 status: proven vs deferred (2026-07-28)

Implemented on branch `m8-c2-forwarder-plan` (NOT closed — tech lead makes the PR/close call, same
posture as C3/`task_39ff` and C4/`task_3b48` already parked on this branch). Commits:

- `060779d` plan
- `72304b7` `cleanupOrphanLauncherProcesses` + `cleanupOrphanScratchDirs`, wired into index.ts

### CORRECTED orphan population (task text was stale — verified against actual code, not assumed)

The task was seeded under the old "podman + krun OCI runtime" plan. The real substrate is the
direct-libkrun launcher (`rust/magpie-microvm-launcher`, task_39ff). Verified on this box:

- **No separate virtiofsd daemon exists, ever.** `/work`/`/out` are attached via
  `krun_add_virtiofs3`, an IN-PROCESS libkrun FFI call (`rust/magpie-microvm-launcher/src/krun.rs`).
  Grepped the whole crate for `Command::new`/`spawn`/`virtiofsd`: zero hits. There was never a
  phantom daemon to chase here.
- **No per-job vsock socket is created by the launcher.** `--vsock-uds` points straight at the
  GATEWAY's own already-bound `<socketDir>/gw.sock` (`microvm-vsock.ts`'s `microvmVsockChannel`;
  `krun_add_vsock_port2(..., listen=false)` makes libkrun a CLIENT that dials OUT). That socket's
  bind/teardown lifecycle belongs entirely to `packages/gateway`'s `JobSocketManager`, a SEPARATE
  process/systemd unit — nothing for this orchestrator-side module to create or unlink.
- **The launcher process IS the micro-VM.** `krun.rs`'s `boot()` returns `Result<Infallible,
  BootError>` — `krun_start_enter` never returns to Rust once the guest boots (confirmed live: see
  below), and the launcher never forks/execs a child. One `magpie-krun-launch` PID == one live
  guest, for its entire life. **This is the real new orphan surface** the old container-only reap
  missed.
- **The other new surface is per-job scratch DIRECTORIES, not sockets**: `container-mounts.ts`'s
  `createOutputDir` (`magpie-out-*`) and `workspace.ts`'s `createWorkspace`
  (`<owner>-<repo>-<pr>-<sha>`) — both directly under `config.workspace.workDir`, confirmed (grep)
  to be the ONLY two writers into that directory anywhere in the orchestrator. Tier-agnostic (both
  predate the micro-VM tier; virtiofs/bind-mount just re-point the same host directories).
- **Podman/docker container reap needs no change** — already byte-identical under rootless podman,
  re-confirmed against the current module (unchanged in this task).

### Gateway-key design fork — RESOLVED as (b), no new endpoint

Chose NOT to add a gateway management-plane list/bulk-revoke endpoint. Justification (also written
inline in `orphan-cleanup.ts`'s `cleanupOrphanLauncherProcesses` doc comment):
1. The gateway is a separate long-running process (own systemd unit) with its own in-memory
   `KeyStore`/`JobSocketManager` — this orchestrator crashing doesn't touch either. There is
   nothing new to revoke as a *consequence* of the orchestrator dying.
2. Once the orphaned launcher process is killed (step 1's reap), the guest — the only thing that
   could ever present that job's virtual key over vsock — no longer exists. A key with no VM left
   to spend it has no remaining attack surface.
3. Independent defense in depth already bounds it regardless: every minted key is TTL-capped
   (`KeyEntry.expiresAt`, lazily evicted) AND budget-capped (`isOverBudget`) — see
   `packages/gateway/src/keystore.ts`.
4. Precedent: `cleanupOrphanContainers` has never revoked a reaped crun container's gateway key
   either, and that was never flagged as a gap. This keeps both tiers consistent rather than adding
   new cross-process surface for a scenario that's already fully bounded — the smaller, correct
   option per the task's own steer.

### PROVEN (implemented + verified on this box)

- **`cleanupOrphanLauncherProcesses`** — enumerates via injectable `ps -eo pid=,args=` (no shell),
  matches on the FULL command line (not `comm`, which Linux truncates to 15 chars — shorter than
  `magpie-krun-launch`'s 19, which a naive `comm`-based match would silently miss), kills matches
  via injectable `process.kill` (no `kill` binary spawn). Gated on `container.tier === "microvm"` —
  a crun-only deployment never calls `ps` at all. Best-effort: a `ps`/kill error is logged and
  swallowed, never thrown.
- **`cleanupOrphanScratchDirs`** — removes every entry directly under `config.workspace.workDir`.
  No traversal surface (paths are always `join(workDir, <readdir-returned-name>)`). ENOENT on a
  not-yet-created workDir is a silent zero-count success; any other error is logged and swallowed.
  A no-op in the common case (clean shutdown already empties the dir via each job's own cleanup) —
  only does real work after a crash, same shape as `cleanupOrphanContainers`.
- **Wired into `index.ts`** alongside the existing `cleanupOrphanContainers` call, each
  independently best-effort so one failing never skips the others.
- **Unit tests** — `orphan-cleanup.test.ts`: 14 new tests for the two new functions (crun-tier
  no-op without calling `ps`; microvm-tier matches/kills/ignores-unrelated; kernel-truncation-proof
  matching; partial-batch kill-error swallowing; `ps`-error swallowing; custom `launcherBin`
  basename matching; scratch-dir removal, ENOENT, listing-error, per-entry-removal-error, no-escape
  path-join proof; a real-filesystem sub-test using actual `mkdtemp`/`readdir`/`fs.rm`) **plus** a
  combined "crash-restart reap" acceptance test that runs all three reap functions
  (containers+processes+scratch-dirs) in the same sequence `index.ts` does and asserts every orphan
  class is gone and the gateway-key non-action is exercised (no gateway URL/key/client is ever
  passed into any of the three calls). **19/19 passed** in this file (5 pre-existing + 14 new).
- **LIVE on-box crash-restart reap of a REAL launcher process** (real `/dev/kvm`, arm64/16 KB
  pages, libkrun v1.19.4, `rust/target/release/magpie-krun-launch`, this box's ambient `kvm` group
  membership — no `sg kvm` needed here): booted a real micro-VM in the background
  (`--rootfs spike/m8-a1/rootfs --exec /bin/sleep --arg 600`, matching the exact argv shape
  `buildMicrovmLaunchArgs` produces), confirmed via `ps` it was alive and running for real (PID
  236533, guest log showed the boot line), then ran `cleanupOrphanLauncherProcesses` with its REAL
  (non-mocked) `ps`/`process.kill` implementation, pointed at the same launcher binary path. It
  found and `SIGKILL`ed the pid; confirmed dead immediately after (`ps -p <pid>` empty, no
  `magpie-krun-launch` process left anywhere on the box). This is the acceptance test's on-box leg,
  proven directly (not simulated/faked) — see the transcript in this session for the exact
  commands/output.
- **Full TS suite** — `npm test`: gateway 75, orchestrator 379 (+4 skipped, up from 365 — the 14
  new are this task's), review-extension 11. All green, no flake in this run.
  `reviewer.test.ts` (the known AbortSignal-timing flake) also re-run in isolation: 28/28 green.
- **M8-B1 floor golden** — `git diff main -- '*reviewer-crun-floor-argv.golden.json'` is EMPTY (no
  crun-path change from this task at all, as expected — this task only touches orphan-cleanup.ts
  and index.ts).

### DEFERRED (not achievable, or genuinely out of scope, here)

- **A true `kill -9` of the parent ORCHESTRATOR process with a real gateway + minted key + a
  launcher spawned by `reviewer.ts` itself** (as opposed to a hand-launched standalone launcher
  process, which is what was actually proven above) — needs a live gateway process, a real minted
  virtual key, and the full `pipeline.ts` job path running end-to-end, none of which are available
  non-interactively on this box (same class of deferral as C3/C4's "no live gateway/GitHub-App"
  gaps). What WAS proven is the actual mechanism this task is responsible for: a running launcher
  process with no live parent doing anything about it gets found and killed by the reap function,
  using real `ps`/real `process.kill`/a real libkrun-booted VM — the parent-process identity is not
  something the reap logic even looks at (it matches on the launcher binary's name only), so this
  gap is narrow.
- **No Rust changes were needed or made** for this task — confirmed by inspection (see the audit
  above) rather than by running `cargo test`; skipped per the task's own "if you touch Rust" gate,
  since nothing here does.
- **amd64** — no amd64 hardware on this box (same standing deferral as every prior M8-C task).
