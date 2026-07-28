---
id: task_df53
title: M8-C5: orphan cleanup — reap VM/podman processes instead of docker kill targets
type: task
status: in_progress
priority: 2
labels: [microvm,reliability]
blocked_by: [task_39ff]
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:55:29Z
updated_at: 2026-07-28T11:38:54Z
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

- [ ] Add `cleanupOrphanLauncherProcesses(config, listProcessesFn, killFn, logger)` to
      `orphan-cleanup.ts`. Enumerate via an injectable `ps -eo pid=,args=` call (execFile, no
      shell), match each line's first whitespace-separated token's `basename()` against
      `basename(config.microvm.launcherBin)`, kill every match with `SIGKILL` via an injectable
      kill function (defaults to `process.kill`, no `kill` binary spawn needed).
- [ ] Gate on `config.container.tier === "microvm"` — on a crun-only deployment, skip the `ps`
      call entirely (matches the task's explicit instruction; also sidesteps any host where `ps`
      might not be on PATH but microvm is never used).
- [ ] Safe-to-reap-all justification (inline comment): this runs at startup, before the queue
      accepts any job, so there are no in-flight launcher processes to avoid — same "reap
      everything named `magpie-*`" model `cleanupOrphanContainers` already uses.
- [ ] Best-effort/never-throws, mirroring the existing module exactly (`ps` missing/erroring,
      or a kill on an already-dead pid (ESRCH), is logged and swallowed).

### 2. Orphaned scratch-dir reap

- [ ] Add `cleanupOrphanScratchDirs(config, listDirFn, rmFn, logger)` to `orphan-cleanup.ts`.
      `readdir(config.workspace.workDir)` (best-effort — ENOENT on a not-yet-created dir is a
      silent zero-count success, not an error) and `rm(entry, { recursive: true, force: true })`
      every entry found directly under it.
- [ ] Injectable `listDirFn`/`rmFn` (default real `fs.readdir`/`fs.rm`) so the test suite never
      touches the real filesystem outside a throwaway tmp dir.
- [ ] Path-join only from `readdir`-returned names (never from any external/attacker input) and
      only under the configured `workspace.workDir`, so there's no traversal surface.
- [ ] Best-effort/never-throws, same contract as the rest of the module.

### 3. Wire into `index.ts`

- [ ] Call all three cleanup functions (containers, launcher processes, scratch dirs) from the
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
- [ ] Write this reasoning as a doc comment in `orphan-cleanup.ts` (not just this task file).

### 5. Tests

- [ ] `orphan-cleanup.test.ts`: new `describe` blocks for
      `cleanupOrphanLauncherProcesses` (crun tier no-ops without calling `ps`; microvm tier lists
      + kills every matching pid; ignores non-matching processes; swallows a `ps`/kill error) and
      `cleanupOrphanScratchDirs` (empty dir → zero removals; several `magpie-out-*` + workspace-shaped
      dirs → all removed; missing dir (ENOENT) → zero removals, no throw; a removal error is
      swallowed and logged).
- [ ] A combined "crash-restart reap" test exercising all three (containers + processes + scratch
      dirs) together with injected fakes, asserting the gateway-key non-action is a documented,
      deliberate no-op (not simply untested) — e.g. a comment/assertion that no gateway client is
      constructed/called anywhere in this module.
- [ ] Time-permitting on-box (`sg kvm`, reusing `spike/m8-a1/rootfs` + the built
      `rust/target/release/magpie-krun-launch`): boot a real launcher, kill its PARENT (or the
      launcher itself, simulating `kill -9` of a process tree) leaving the launcher/VM running,
      then run `cleanupOrphanLauncherProcesses` for real and confirm the PID is gone
      (`kill -0` fails after). If this isn't cleanly achievable non-interactively, defer explicitly
      — same posture as C3/C4's live e2e deferrals.

### 6. Verification

- [ ] `npm test` (full workspace); re-run `reviewer.test.ts` in isolation if the known-flaky
      AbortSignal test flakes.
- [ ] `git diff main -- '*reviewer-crun-floor-argv.golden.json'` must be EMPTY (no touches to the
      crun path expected from this task at all).
- [ ] No Rust changes expected for this task; skip the cargo step unless something forces one.

### 7. Process

- [ ] Commit incrementally, `chore/feat/test(m8-c5): ...`, trailer `Co-Authored-By: Claude Opus
      4.8 <noreply@anthropic.com>`.
- [ ] Leave `task_df53` `in_progress`; append a "C5 status: proven vs deferred" section instead of
      closing (tech lead makes the PR/close call, same as C3/C4 on this same branch).
