---
id: task_39ff
title: M8-C3: micro-VM tier end-to-end — port reviewer launch to krun under rootless podman (crun floor stays feature-flagged fallback)
type: task
status: in_progress
priority: 1
labels: [microvm,security]
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:55:10Z
updated_at: 2026-07-27T03:20:09Z
---
Brief §8 phase 3: the core port. Launch the reviewer as a rootless KVM micro-VM (podman +
krun OCI runtime) end-to-end, with the hardened crun tier remaining as the feature-flagged
fallback (it is the ladder floor, never deleted).

Plan:
- [ ] reviewer.ts: swap the container invocation for podman-with-krun; drop the gateway
      socket-dir bind mount (vsock replaces it); add guest RAM/vCPU flags.
- [ ] container-mounts.ts: /work rides a read-only virtiofs mount in the micro-VM tier; stays a
      read-only bind mount for the crun tier. (.git-strip and read-only semantics identical in
      both.)
- [ ] Concurrency: default guest RAM ~1 GB/review; queue concurrency = floor(available_RAM/guest_RAM),
      min 1, both configurable (brief §6.4).
- [ ] Dead-VM handling (OOM/panic/timeout) maps onto the existing clear-failure-note publisher
      path; add a test.
- [ ] Uid-split check (CTO edit 1): confirm the vsock/virtiofs rewiring did not move any gateway
      credential into the orchestrator; the reviewer still receives only the per-job virtual key.
- [ ] Floor test (M8-B1) still green — the crun fallback path is byte-for-byte unchanged.
- [ ] Full e2e: webhook → queue → micro-VM review → findings → published COMMENT review, on
      amd64 and the 16 KB-page arm64 box.

Done when: micro-VM tier reviews a real PR end-to-end on both arches with the crun floor intact
behind a flag.

---

## C2 collapsed into this task (2026-07-27)

Per CTO call, **M8-C2 (`task_b3f7`, closed) is folded into C3.** The direct-wiring investigation
+ hardware spike proved the "host-side per-VM vsock↔gateway forwarder" is NOT a separate
component: launch the reviewer via the **direct-libkrun launcher** (`rust/magpie-microvm-launcher`,
bin `magpie-krun-launch`) and point its `--vsock-uds` straight at the gateway's per-job
`gw.sock`. See `task_b3f7` (now in `.chalk/tasks/closed/`) for the full plan, and
`spike/m8-c2/direct-wiring-spike.md` for the passing 5-assertion spike (real `/dev/kvm`, arm64/16 KB).

Absorbed C2 responsibilities (in addition to the plan above):
- [ ] **Launch mechanism:** use `magpie-krun-launch` (direct libkrun), NOT `podman --runtime krun`
      — the M8-A1 spike found podman+krun can't reach the needed calls (TSI-off, per-VM vsock,
      `--user`). The "podman + krun OCI runtime" wording in the plan above is superseded by the
      standalone launcher (`task_76d6`, closed).
- [ ] **Consume `packages/orchestrator/src/microvm-vsock.ts`** (delivered on branch
      `m8-c2-forwarder-plan`, commit `4c6791e`): `microvmVsockChannel(gatewayKey)` →
      `{ udsPath: <socketDir>/gw.sock, port: 1234 }`, threaded into the launcher's
      `--vsock-uds`/`--vsock-port`. No separate forwarder process; no host-global vhost-vsock.
- [ ] **uid-split invariant** holds — the launcher receives only a filesystem path, never a
      credential (satisfies the C2 constraint + CTO edit 1).
- [ ] **Guest-side prerequisite:** the reviewer image entrypoint must `su-exec`/`setpriv` down
      from root before Pi (see `magpie-krun-launch` main.rs scope notes) and mount the read-only
      `/work` virtiofs device inside the guest.

### RESOLVED gate → C3 acceptance criterion: the vsock-uds teardown-vs-flush race

`bug_73b2` (P1) is CLOSED (2026-07-27, commit `91b54e1` on this branch) — root-caused and the
gate is satisfied. The finding was that the guest relay `rust/vsock-client` is **NOT** defective:
its source is byte-for-byte unchanged from `main`. The reply loss was a **timing race in
libkrun's own `--vsock-uds` bridge** (the exact transport C3 depends on): when the *host* peer
calls `shutdown(SHUT_WR)` in the same tick as `sendall()`-ing its reply, the bridge can
propagate the teardown to the guest before it finishes flushing the just-sent bytes, so the
guest sees a bare EOF instead of the reply. Fully documented in `.chalk/tasks/closed/bug_73b2.md`.

**This is a real, external-dependency transport property, not a harness quirk** — it reproduced
even against a persistent multi-accept host stub (10/10 lost), and was only masked by inserting
a gap before the host's `shutdown()`. So C3 MUST NOT assume immunity. Carry these as hard
acceptance criteria:

- [ ] **Prove the real gateway never triggers it.** `packages/gateway`'s proxy plane replies via
      Node `http.createServer` → `res.write()`/`res.end()` with keep-alive (see
      `proxy-server.ts` ~L244-261), which schedules FIN through libuv asynchronously rather than
      issuing a synchronous `shutdown()` in the last-write tick — structurally much safer than
      the spike's Python stub. But **verify, don't assume**: add a C3 integration test that
      drives a real (or faithfully-modelled) gateway reply → guest over the vsock-uds bridge and
      asserts ZERO byte loss, explicitly including the gateway's abort/error/`res.destroy()`
      teardown paths (the most likely place a prompt close-after-partial-write could sneak in).
- [ ] **If any gateway path can close promptly after writing,** either fix it to defer the close
      until bytes are flushed, or add a guest-/host-side guard — do not ship live Pi↔gateway
      traffic over a path that can silently drop a reply. Repro harness: `spike/m8-c2/`.

## C3 implementation plan (2026-07-27)

Working on `m8-c2-forwarder-plan` (consolidated C2+C3 branch, no new branch, no push, no PR).

### 0. Design forks resolved up front (documented, not stalled on)

- **Secret-on-launcher-argv problem.** `magpie-krun-launch`'s only way to set a guest env var
  today is `--env KEY=VALUE` — literally on argv, visible via `/proc/<pid>/cmdline` to any
  local user. That would put the gateway virtual key on argv, violating the same
  "never in argv, only in env" invariant `reviewer.ts` already documents for the docker path
  (`-e OPENROUTER_API_KEY` name-only) and directly contradicts CTO edit 1 (uid-split /
  no-credential-on-launcher-argv, a merge blocker). Fix: add a new launcher flag
  `--env-from-host <NAME>` (repeatable) that reads `NAME`'s value from the **launcher
  process's own environment** (which `reviewer.ts` sets via `spawn(bin, argv, { env })`,
  exactly like it already does for the docker client) and forwards `NAME=<value>` into the
  guest's envp — mirroring docker's `-e NAME` name-only convention exactly. Only
  `OPENROUTER_API_KEY` uses this path; `OPENAI_BASE_URL`/`MAGPIE_REQUIRE_MEMORY_LIMIT` are
  non-secret and go via plain `--env KEY=VALUE` (matches docker's inline-non-secret
  convention for `OPENAI_BASE_URL` today).
- **Findings retrieval (`/out`) has no launcher flag today.** The CLI contract only exposes
  one read-only virtiofs device (`--work-mount`). Without a writable channel out, the guest
  can never hand back `findings.json`. Fix: add a second flag, `--out-mount <host-path>[:<tag>]`,
  mirroring `--work-mount` but attached `read_only=false` (`krun_add_virtiofs3`'s existing
  4th arg already supports this — no new libkrun call needed). This lets `container-mounts.ts`'s
  existing `createOutputDir`/`findingsPath` be reused completely unchanged across both tiers.
  Verify empirically on this box (via `sg kvm`) whether a file the guest writes as a non-root
  uid lands host-side owned by the orchestrator's own uid (matching plain docker's behavior)
  or needs an explicit permission fix (matching the M8-B2 podman `--userns=keep-id` lesson,
  `task_08ec`) — do not assume, test it.

### 1. Rust launcher (`rust/magpie-microvm-launcher`)
- [ ] `src/cli.rs`: add `--out-mount <host-path>[:<tag>]` (mirrors `--work-mount` parsing).
- [ ] `src/cli.rs`: add `--env-from-host <NAME>` (repeatable). Resolve via an injectable lookup
      (`parse_with_env_lookup`, default `std::env::var`) so it stays unit-testable with a fake
      env — `parse()`'s existing signature/tests stay unchanged.
- [ ] `src/config.rs`: add `out_mount: Option<WorkMount>` (or equivalent) to `LaunchConfig`/
      `LaunchConfigInput`, validated the same way as `work_mount` (absolute path, non-empty tag).
- [ ] `src/krun.rs`: attach `out_mount` via a second `krun_add_virtiofs3` call, `read_only: false`.
- [ ] Unit tests for all of the above (cli.rs + config.rs), mirroring the existing work-mount/
      vsock-pair test shapes.
- [ ] `cargo build --release && cargo test --workspace` green.
- [ ] Empirically boot via `sg kvm` with both mounts + a non-root guest write to `/out`, confirm
      host-side ownership/permissions, adjust `createOutputDir`/entrypoint approach if needed.

### 2. Orchestrator config (`packages/orchestrator/src/config.ts`)
- [ ] `container.tier: "crun" | "microvm"`, default `"crun"`.
- [ ] New `microvm` section: `ram_mib` (default 1024), `vcpus` (default 2), `rootfs_path`
      (absolute, required when tier=microvm), `host_ram_budget_mib` (default, for concurrency),
      `launcher_bin` (default `magpie-krun-launch`), `out_mount_tag`/`work_mount_tag` if needed.
      Mirror the zod + typed-Config style exactly; fail closed at load if tier=microvm and
      rootfs_path is missing/relative.
- [ ] `resolveQueueConcurrency(config)`: crun tier unchanged (`limits.concurrency`); microvm tier
      = `max(1, floor(host_ram_budget_mib / ram_mib))`. Wire into `queue.ts`'s
      `jobQueueOptionsFromConfig`.

### 3. `reviewer.ts` tier ladder
- [ ] `buildMicrovmLaunchArgs(...)`: pure builder for `magpie-krun-launch` argv, analogous to
      `buildReviewDockerArgs`. Unit-tested (new `reviewer-microvm-argv.test.ts`), including an
      explicit assertion that the gateway virtual key never appears as a literal in the argv
      (only `--env-from-host OPENROUTER_API_KEY`, name-only) — the uid-split/CTO-edit-1 merge
      blocker test.
- [ ] `runReview`: branch on `config.container.tier`. crun path (`buildReviewDockerArgs` +
      spawn) stays byte-for-byte unchanged — zero edits to `reviewer-crun-floor-argv.test.ts`'s
      fixture. microvm path spawns `magpie-krun-launch` with the built argv, `--vsock-uds`/
      `--vsock-port` from `microvmVsockChannel(gatewayKey-shaped input)`, `--work-mount
      <mountDir>:work`, `--out-mount <outDir>:out`, `--uid/--gid` = `process.getuid()/getgid()`,
      no gateway-socket-dir bind mount (vsock replaces it).
- [ ] Kill path: no `docker kill <name>` for microvm — killing the launcher process IS killing
      the VM (`krun_start_enter` never returns). Skip `killContainerBestEffort` for this tier;
      SIGTERM→SIGKILL on the launcher child is sufficient.
- [ ] Dead-VM handling: non-zero launcher exit / timeout / abort all still resolve
      `{ ok: false, reason }` through the existing settle path — add a test.

### 4. Guest-side entrypoint (`docker/reviewer/entrypoint.sh`, `Dockerfile`)
- [ ] Guard new logic behind the existing `[ -c /dev/vsock ]` tier signal (already used to pick
      `vsock-client` vs `forwarder.mjs`).
- [ ] Mount both virtiofs devices before anything else needs them: `mount -t virtiofs work /work`,
      `mount -t virtiofs out /out`.
- [ ] Drop privileges before `exec pi`: `setpriv --reuid=10001 --regid=10001 --clear-groups
      --no-new-privs exec pi ...` using the image's already-baked-in `reviewer` uid/gid (10001)
      — the guest boots root (`krun_setuid`/`krun_setgid` only confine the HOST VMM, per
      `src/krun.rs`), so this is the real, previously-dormant purpose of that baked-in user.
      Ensure `util-linux` (for `setpriv`/`mount`) is present in the image.
- [ ] Note in the report: this is a source change; the published signed image needs a rebuild,
      out of scope here.

### 5. Concurrency — covered by 2 above (config.ts + queue.ts wiring).

### 6. bug_73b2 acceptance test (packages/gateway)
- [ ] New integration test driving a REAL `createProxyServer` bound to a real unix socket
      (mirrors `job-sockets.ts` production shape), a raw low-level client, and a stubbed
      upstream — covering: normal keep-alive completion, an upstream error (502) response, and
      the client-disconnect/abort path — asserting zero byte loss / no premature shutdown before
      full flush on every path.
- [ ] Time-permitting: an additional real hardware check via `sg kvm` — boot the actual launcher
      with `--vsock-uds` pointed at a real `packages/gateway` proxy server instance and drive a
      review-shaped HTTP round trip from inside the guest, to validate the transport end-to-end
      rather than only the gateway's own write/close ordering in isolation.

### 7. Verification
- [ ] `cd rust && cargo build --release && cargo test --workspace`
- [ ] `npm test` (full workspace) + isolated re-run of the known-flaky
      `reviewer.test.ts` AbortSignal test if it flakes
- [ ] M8-B1 floor golden green, zero fixture edits
- [ ] Live micro-VM run(s) via `sg kvm`, reusing `smoke-test.sh`/spike artifacts where possible
- [ ] Do NOT claim two-arch/full-webhook e2e — defer explicitly (no amd64 hw, no image
      republish, no M8-D3 provisioning here).

### 8. Process
- [ ] Commit incrementally (Rust changes, config, reviewer.ts, entrypoint, tests, verification)
- [ ] Leave `task_39ff` `in_progress`; append a "C3 status: proven vs deferred" section at the
      end instead of closing.

## C3 status: proven vs deferred (2026-07-27)

Implemented on branch `m8-c2-forwarder-plan` (NOT closed — the "done when: full
webhook→published-review e2e on BOTH arches" bar is not fully achievable on this
single arm64 box; tech lead to make the close/PR call). Commits:

- `d855242` plan
- `3745cce` launcher: `--env-from-host` + `--out-mount`
- `d17302e` config `container.tier` + `[microvm]` + queue concurrency
- `788933a` reviewer.ts micro-VM tier launch path + argv builder/preflight
- `da33c8a` dead-VM handling tests + tier-agnostic spawn-error wording
- `54df58a` entrypoint.sh guest virtiofs mounts + setpriv privilege drop + Dockerfile util-linux
- `968a2b8` pipeline tier wiring + uid-split merge-blocker test (pipeline level)
- `f852788` bug_73b2 acceptance test (gateway flush safety over a unix socket)
- `2dfdcef` live micro-VM e2e (out-mount + env-from-host + vsock round-trip)

### PROVEN (implemented + verified on this box)

- **Rust launcher extensions** (`--env-from-host <NAME>`, `--out-mount
  <host>[:<tag>]`, `WorkMount.read_only`). `cargo build --release` +
  `cargo test --workspace` GREEN (65 launcher + 14 vsock-client + 5 framing).
- **Config surface** — `container.tier` (`crun`|`microvm`, default `crun`) +
  `[microvm]` block (ram_mib/vcpus/rootfs_path/host_ram_budget_mib/launcher_bin),
  zod-validated, fail-closed at load if `microvm` tier has no absolute rootfs.
- **Queue concurrency** — `resolveQueueConcurrency`: crun unchanged, microvm =
  `floor(host_ram_budget_mib/ram_mib)` min 1.
- **reviewer.ts tier ladder** — pure `buildMicrovmLaunchArgs` +
  `findMissingMicrovmFlags`; crun path byte-for-byte unchanged; kill path skips
  `docker kill` for microvm (launcher process == VM).
- **UID-SPLIT INVARIANT (CTO edit 1, MERGE BLOCKER)** — covered by THREE tests:
  `reviewer-microvm-argv.test.ts` (builder can't emit the key), reviewer.test.ts
  microvm suite (runReview level), and pipeline.test.ts microvm suite (end-to-end:
  key reaches launcher ENV, never argv). Confirmed live too — the launcher boot
  line carries no key.
- **Guest privilege drop + in-guest virtiofs mounts** — entrypoint.sh (guarded on
  the `/dev/vsock` tier signal, crun path untouched): `mount -t virtiofs` for
  `/work` (ro) + `/out` (rw), then `setpriv --reuid/--regid 10001 --clear-groups
  --no-new-privs` before `exec pi`. Dockerfile: `util-linux` added. Source only —
  image rebuild is downstream (see DEFERRED).
- **Dead-VM handling** — non-zero launcher exit / timeout / abort / unspawnable
  binary all resolve `{ ok:false, reason }` (never throw); tests added.
- **pipeline.ts wiring** — tier selected inside runReview from config (call shape
  unchanged across tiers); tier logged for operators only.
- **bug_73b2 acceptance** — `proxy-server-flush.test.ts`: real gateway on a UNIX
  SOCKET, ZERO byte loss on every teardown path (normal / 1 MiB multi-segment /
  502 / 402 / upstream-error-after-headers / client-abort). AUDIT: no gateway
  code change needed — it replies only via `res.write()`/`res.end()`, never
  `res.destroy()`/same-tick shutdown (the safe shape). 7/7 green.
- **Full TS suite** — `npm test` GREEN: gateway 75, orchestrator 361 (+4 skipped),
  review-extension 11. reviewer.test.ts (incl. the known AbortSignal-timing flake)
  passed in the full run AND in isolation.
- **M8-B1 floor golden** — GREEN with ZERO fixture edits (`git diff main` on
  `reviewer-crun-floor-argv.golden.json` is empty).
- **LIVE micro-VM run** (`sg kvm -c 'spike/m8-c2/c3-live-e2e.sh'`, real
  /dev/kvm + libkrun v1.19.4, arm64/16 KB) — ALL PASSED: `--out-mount` writable
  (guest-written findings.json landed host-side), `--env-from-host` (secret in
  guest env, absent from argv), and a gateway-shaped review round-trip over the
  REAL libkrun `--vsock-uds` bridge with ZERO byte loss (200000/200000 reply
  bytes, JSON parsed intact). Also re-ran `smoke-test.sh` GREEN (launcher boot +
  vsock + read-only /work unaffected by the Rust changes).

### DEFERRED (not achievable on this box / out of C3 scope)

- **Reviewer image rebuild/republish** — entrypoint.sh + Dockerfile are SOURCE
  changes; the cosign-signed multi-arch GHCR image must be rebuilt for a live
  micro-VM review to pick up the mounts + privilege drop. Can't publish the
  signed image here.
- **Full webhook→published-review live pipeline under the microvm tier** — needs
  a real gateway + GitHub App + the republished image + M8-D3 host provisioning
  (subuid/subgid, linger, kvm group, rootfs staging — `task_67aa`), none doable
  non-interactively here. The e2e is proven in PIECES (pipeline.test.ts microvm
  suite drives webhook→published review with a fake launcher; the live run proves
  the real transport/mounts) but not as one continuous live flow.
- **amd64** — no amd64 hardware on this box; the second-arch live e2e is deferred.
- **In-guest privilege-drop under the REAL entrypoint** — the live run used a
  standalone guest probe (the real entrypoint needs a real gateway + sk-magpie-
  key + healthz); the setpriv drop itself is source-verified + will exercise once
  the image is rebuilt and M8-D3 provisioning lands.
