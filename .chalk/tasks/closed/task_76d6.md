---
id: task_76d6
title: M8-C0: host-side micro-VM launcher — direct libkrun (TSI-off no-network + per-VM vsock gateway port + setuid + vcpu/RAM)
type: task
status: closed
priority: 1
labels: [rust,microvm,libkrun]
blocked_by: []
parent: epic_59b1
remote_task_url: https://github.com/andrew-craig/magpie/pull/55
created_at: 2026-07-21T21:39:41Z
updated_at: 2026-07-25T04:47:46Z
---
Net-new component surfaced by the M8-A1 spike (`task_1fdc`,
`spike/m8-a1/frontend-investigation.md`). The spike found that driving libkrun via crun's krun
handler under `podman --runtime krun` **cannot** produce our required posture: crun's shim leaves
TSI on (no provable no-network), silently ignores `--user`, and reads vcpu/RAM only via
`krun.cpus`/`krun.ram_mib` annotations. All the levers we need are in libkrun's own C ABI, which
crun simply never calls. So the reviewer front-end becomes a small binary **we** own that links
libkrun and makes those calls directly. This task builds that launcher; it is the foundation the
rest of the C-phase sits on (hence M8-C0, ahead of the M8-C3 tier port `task_39ff`, which now
builds ON this rather than on `podman --runtime krun`).

Language is **Rust** (RUST-1 / `decision_aa2d`): libkrun is a C ABI whose entry point
`krun_start_enter` does not return, which is hostile to Go/cgo; Rust binds it cleanly and is
memory-safe for a privileged component. The M8-A1 spike proved the shape end-to-end with a C
prototype (`spike/m8-a1/magpie-krun-launch.c`) and a Rust guest client
(`spike/m8-a1/vsock-client/`, commit `f47eaf3`); this task is the production Rust launcher.

The call sequence, all verified working in the spike (see the frontend doc):
- `krun_create_ctx` → `krun_set_vm_config(vcpus, ram_mib)` — the vcpu/RAM controls that
  `--cpus`/`--memory` failed to set. VMM-enforced RAM also structurally fixes `bug_df2d`.
- `krun_set_root` (or `krun_add_virtiofs`) for the read-only `/work` mount + reviewer rootfs.
- `krun_disable_implicit_vsock` + `krun_add_vsock(ctx, 0)` — **TSI off**: this is the mechanism
  that realises `task_3b48`'s provable no-network (guest left with only a down, routeless dummy).
- `krun_add_vsock_port2(port, uds_path, listen=false)` — the **per-VM HYBRID gateway channel**
  (`task_a163`/`task_b3f7`): one host-side unix socket path per job, libkrun connects out to it
  when the guest dials the port. Never a host-global listener.
- `krun_setuid`/`krun_setgid` — non-root guest, the `--user` gap. NOTE: the spike found libkrun's
  *guest init* does not honour this today; confirm whether `krun_setuid` covers it, else fall back
  to the image-side `su-exec` mitigation (record which).
- `krun_set_workdir` / `krun_set_exec` / `krun_set_env` — argv/env contract. WATCH: exec+args are
  packed into the kernel cmdline and must be plain ASCII (a multi-line arg panicked host-side with
  `InvalidAscii` in the spike).

Plan:
- [x] Rust binary in the cargo workspace (RUST-2 / `task_2a18`); binds the libkrun C ABI (bindgen
      or hand-written `extern "C"`, wrapped in a safe module). Pin libkrun to a known ABI (spike
      used v1.19.4 = ABI 1; crun-independent here, but pin it). DONE: hand-written `extern "C"` in
      `rust/magpie-microvm-launcher/src/krun.rs`, ABI pinned via `LIBKRUN_ABI_PIN`.
- [x] Owns the reviewer launch contract today in `reviewer.ts`/`container-mounts.ts`: read-only
      `/work`, per-job gateway socket, non-root, resource caps — mapped to the calls above.
      DONE IN LIBKRUN TERMS (not wired into `reviewer.ts` itself — see confirmed scope above and
      `task_39ff`): read-only `/work` -> `krun_add_virtiofs3(read_only=true)`; per-job gateway
      socket -> `krun_add_vsock_port2` (one uds path per job, never global); non-root -> host-side
      `krun_setuid`/`krun_setgid` (see the Review section's finding on guest confinement);
      resource caps -> `krun_set_vm_config` (VMM-enforced, not a cgroup).
- [ ] Spawned by the orchestrator as a subprocess exactly where `docker run` is invoked today
      (`reviewer.ts`); JSON/NDJSON stdout contract preserved so `findings.ts` is unchanged.
      OUT OF SCOPE for this task per the confirmed scope above — this is `task_39ff` (M8-C3), which
      builds ON this launcher. Not done here by design.
- [x] OCI-image→rootfs prep: net-new work podman gives for free today. Decide unpack-to-dir
      (spike used `podman export` + virtiofs) vs `krun_set_root_disk` ext4 image (brief §6.2).
      Feeds `task_08ec` and the effort estimate. DECIDED (per confirmed scope above): unpack-to-dir,
      via `krun_set_root` — reused the spike's already-exported `spike/m8-a1/rootfs/` rather than
      re-exporting. Did NOT build the `krun_set_root_disk` ext4 path.
- [x] Secret split (epic_59b1 CTO edit 1, MERGE BLOCKER): the launcher is orchestrator-side; it
      must NOT hold the provider key. The gateway keeps its own uid; its per-job socket is handed
      to the VM via `krun_add_vsock_port2`. Preserve orchestrator ⟂ gateway uid separation. HOLDS:
      the launcher's CLI/config surface carries only a vsock port + a host uds PATH (never a
      credential); nothing in `src/`, `Cargo.toml`, or `smoke-test.sh` reads/logs/embeds a provider
      key. The gateway process (separate uid, unmodified by this task) still owns the real key.
- [x] `/dev/kvm` access via the group + `keep-groups` path proven in the spike (no setfacl, no
      0666) — but note: outside podman we manage the userns/kvm access ourselves; confirm the
      rootless-launcher path to `/dev/kvm`. CONFIRMED: plain `kvm`-group membership is sufficient
      (no `--group-add keep-groups` equivalent needed — this launcher has no container/namespace
      layer of its own). See `src/main.rs`'s "`/dev/kvm` access" doc section and the Review section
      below for the `krun_setuid`/`sg kvm` gid interaction this surfaced.
- [x] Unit tests (Rust) for arg/config assembly; boundary behaviour via the RUST-3 contract suite
      (`task_9d2b`) and the reviewer-launch e2e tests. DONE: 49 unit tests across `cli.rs`/
      `config.rs`/`krun.rs`, all running under plain `cargo test` with no VM/KVM. Wiring this into
      RUST-3's contract suite / the reviewer-launch e2e tests is `task_39ff`'s job once this
      launcher is actually driven by the orchestrator.

Relationship to other tasks:
- Supersedes the `podman --runtime krun` approach in `task_39ff` (M8-C3), which now builds on this
  launcher. `task_39ff` should be re-scoped accordingly when it's picked up.
- Realises `task_3b48` (no-network) and provides the host end of `task_a163`/`task_b3f7`.
- Gated on `decision_06c2` (libkrun go/no-go) and `task_08ec` (rootless substrate).

Done when: the launcher boots the real reviewer image as a rootless micro-VM with TSI-off
no-network, a working per-VM gateway vsock channel, VMM-enforced vcpu/RAM, and the read-only
`/work` contract — driven by the orchestrator in place of `docker run`, with the secret split
intact.

## Scope confirmed with tech lead (2026-07-25)

1. **Standalone launcher + tests ONLY.** Deliver the production Rust launcher as a new crate in
   `rust/`. Do NOT modify `packages/orchestrator/src/reviewer.ts` or wire this into the
   orchestrator pipeline — that's `task_39ff` (M8-C3), which builds ON this. Not opening a PR;
   tech lead reviews first.
2. **Rootfs prep = virtiofs unpack-to-dir**, exactly as the spike ran it (`podman export` +
   `krun_set_root`). Do NOT build the `krun_set_root_disk` ext4-image path.

## Implementation plan

- [x] `rust/magpie-microvm-launcher/` crate (bin `magpie-krun-launch`): `Cargo.toml` (workspace
      member, dynamic-link doc'd), `build.rs` (`-L/usr/local/lib64 -lkrun`), `src/krun.rs` (raw
      `extern "C"` bindings for the 11 calls + safe `Launcher` wrapper), `src/config.rs`
      (`LaunchConfig` + pure validation: cmdline-ASCII guard, non-root uid/gid, vcpu/ram bounds,
      paired vsock port/uds), `src/cli.rs` (hand-rolled flag parser, no new deps beyond `libc`),
      `src/main.rs` (wires cli -> config -> krun boot sequence).
- [x] Call sequence ported faithfully from `magpie-krun-launch.c`: create_ctx -> set_vm_config ->
      set_root (+ optional add_virtiofs3 for `/work`, read-only) -> disable_implicit_vsock ->
      add_vsock(0) -> [optional add_vsock_port2] -> setuid/setgid -> set_workdir -> set_exec ->
      start_enter.
- [x] `krun_setuid`/`krun_setgid` vs guest confinement: confirm empirically (via smoke test `id`
      inside the guest) whether calling these directly (bypassing crun, which never calls them)
      confines the GUEST or only the host-side VMM process. Source-level pointer already in hand
      (`flag-investigation.md` §3, `lib.rs:2993-3003` — `vmm_uid`/`vmm_gid`, applied host-side via
      `libc::setuid`), but the task demands empirical confirmation through this launcher's own
      direct calls, not just through crun's shim.
- [x] CLI/contract: promote spike's `MAGPIE_VSOCK_UDS`/`MAGPIE_VSOCK_PORT` env vars to flags
      (`--vsock-uds`/`--vsock-port`, paired validation) for a single explicit, testable contract.
      `--work-mount <host_path>` wires `krun_add_virtiofs3` for the read-only `/work` device; per
      this task's standalone scope, MOUNTING it inside the guest (`mount -t virtiofs work /work`)
      is the exec target's job, not the launcher's — the launcher only attaches the device.
- [x] Rust unit tests (no VM/KVM): CLI parsing, ASCII/cmdline-safety guard, uid/gid rejection,
      vcpu/ram bounds, vsock port/uds pairing, work-mount parsing.
- [x] CI honesty: `rust/magpie-microvm-launcher` dynamically links a host-only `libkrun.so` not
      present on generic GitHub-hosted runners. Add it to the workspace `members` (for local dev /
      `cargo metadata`) but EXCLUDE it from `.github/workflows/rust.yml`'s workspace-wide
      lint/build steps (which would otherwise fail to link on runners without libkrun installed),
      with a comment explaining why and noting a libkrun-equipped self-hosted runner is future
      work, not in this task's scope.
- [x] Live smoke test (`sg kvm`) against the real exported reviewer rootfs
      (`spike/m8-a1/rootfs/`, reused rather than re-exporting): assert TSI off (dummy0 down, empty
      route table, `connect()` fails), a working vsock round-trip to a host `vsock-host-listener.py`
      instance, VMM-enforced vcpu count + RAM, the guest's actual uid despite `krun_setuid`, and
      (if time permits) a `/work` virtiofs mount + read-only round-trip. Paste real output into the
      Review section below.
- [x] `cargo build`, `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`
      for the crate (and confirm the rest of the workspace is unaffected).
- [x] Review section below: rootfs-prep approach, krun_setuid vs su-exec finding + evidence,
      dynamic-link decision, `/dev/kvm` path, smoke-test output.

## Review

**Crate layout** (`rust/magpie-microvm-launcher/`, bin `magpie-krun-launch`, workspace member):
`Cargo.toml` (dynamic-link doc'd at length), `build.rs` (`-L$MAGPIE_LIBKRUN_LIB_DIR -lkrun`,
default `/usr/local/lib64`), `src/config.rs` (pure `LaunchConfig`/validation, no FFI), `src/cli.rs`
(hand-rolled flag parser, no new deps beyond `libc`), `src/krun.rs` (the `extern "C"` bindings +
safe `boot()`), `src/main.rs` (wiring + exit codes + doc comments on scope/`/dev/kvm`),
`smoke-test.sh` (live boot harness). 49 unit tests, all passing, no VM/KVM required.

**Rootfs prep.** Unpack-to-dir via `krun_set_root`, exactly per the confirmed scope — reused the
spike's already-exported `spike/m8-a1/rootfs/` (a real `podman export` of the actual
`magpie-reviewer` image) rather than re-exporting. Did not touch `krun_set_root_disk`/ext4.

**`krun_setuid`/`krun_setgid` vs guest confinement — CONFIRMED: does NOT confine the guest.**
Two lines of evidence:
1. Source: `spike/m8-a1/libkrun/src/libkrun/src/lib.rs:2299-2318` stores the id as `vmm_uid`/
   `vmm_gid`; `lib.rs:2993-3003` applies it via plain `libc::setuid()`/`setgid()` on the HOST
   process before `krun_start_enter` boots the VM. The guest is a separate kernel+init
   (`spike/m8-a1/libkrun/src/init_blob/init/init.c`) with no uid/gid-handling code at all.
2. **Empirical, through this launcher's own direct calls** (not crun's shim, which never even
   calls `krun_setuid`): with `krun_setuid`/`krun_setgid` called and the guest's `smoke-probe.sh`
   running `id`, the guest reported:
   ```
   ===ID===
   uid=0(root) gid=0(root) groups=0(root)
   ```
   Confirmed on two separate smoke-test runs. **Conclusion: the launcher still calls
   `krun_setuid`/`krun_setgid` (defence-in-depth on the host-side VMM process — the same
   protection `--user` gave under docker/crun), but the guest is ALWAYS root today.** The
   `su-exec` fallback (reviewer image entrypoint self-dropping privilege before running Pi) is a
   real prerequisite for `task_39ff`, not optional — recorded in `src/krun.rs`'s module doc
   comment as the load-bearing finding of this file.

**Dynamic-link decision.** This crate targets the host's default `aarch64-unknown-linux-gnu` (NOT
the workspace's pinned musl targets) and dynamically links `libkrun.so.1` via `build.rs`
(`-L/usr/local/lib64 -lkrun`) — confirmed via `file`/`ldd` on the release binary:
```
target/release/magpie-krun-launch: ELF 64-bit LSB pie executable, ARM aarch64, ..., dynamically linked, interpreter /lib/ld-linux-aarch64.so.1, ...
	libkrun.so.1 => /usr/local/lib64/libkrun.so.1 (...)
```
`.github/workflows/rust.yml` now excludes this crate from the shared `lint` (clippy/test) and
`build` (static-musl matrix) jobs — see that file's SCOPE NOTE — because GitHub-hosted runners
don't have libkrun installed and this crate has no static-musl form to belong in that matrix
regardless. Verified locally that the exact CI-equivalent excluding commands still succeed for
the rest of the workspace (`cargo clippy --workspace --exclude magpie-microvm-launcher
--all-targets -- -D warnings`, `cargo test --workspace --exclude magpie-microvm-launcher`,
`cargo build --release --workspace --exclude magpie-microvm-launcher --target
aarch64-unknown-linux-musl`), and that `cargo fmt --check` (unaffected by linking) still covers
the whole workspace including this crate.

**`/dev/kvm` path.** Plain `kvm`-group membership is sufficient — no `setfacl`, no `0666`. Unlike
the spike's podman-fronted experiments, this launcher has no container/namespace layer of its own
between it and `/dev/kvm`, so podman's `--group-add keep-groups` equivalent isn't needed. One real
wrinkle surfaced BY this launcher (not present in the podman-fronted spike, which never called
`krun_setuid` at all): `sg kvm -c '...'` changes the invoking shell's real/effective/saved GID to
`kvm`'s gid for that command, and `krun_setuid`/`krun_setgid`'s underlying `setuid(2)`/`setgid(2)`
only accept a target the process ALREADY holds as real/effective/saved — not a merely-supplementary
group. Passing a `--gid` captured BEFORE entering the `sg kvm` context (e.g. the reviewer image's
baked-in `10001`, or even the outer shell's own `id -g`) fails closed:
```
magpie-krun-launch: boot failed: krun_start_enter failed: -1 (Operation not permitted (os error 1))
```
(confirmed via `strace -f -e trace=setuid,setgid`: `setgid(1000) = -1 EPERM`). Fixed by resolving
`--uid $(id -u) --gid $(id -g)` INSIDE the `sg kvm` subshell — see `smoke-test.sh` and
`src/main.rs`'s "`/dev/kvm` access" doc section for the full writeup. Not a production blocker: a
long-lived service process whose primary group already includes `kvm` doesn't hit this at all — it
only bit the ad-hoc `sg kvm` invocation style.

**Smoke test — full verbatim output** (`rust/magpie-microvm-launcher/smoke-test.sh`, run via `sg
kvm`, against the real `podman export`-ed `magpie-reviewer` rootfs, 2 vcpus / 512 MiB requested,
`--vsock-port 1234` to a fresh per-run host uds, `--work-mount` pointing at a tiny fixture dir):
```
=== booting micro-VM (rootfs=/home/operator/magpie/spike/m8-a1/rootfs) ===
magpie-krun-launch: booting rootfs="/home/operator/magpie/spike/m8-a1/rootfs" exec="/bin/sh" vcpus=2 ram_mib=512 uid=1000 gid=104 vsock=1234 work_mount=work (libkrun ABI: v1.19.4 (ABI 1))
===ID===
uid=0(root) gid=0(root) groups=0(root)
===IFACES===
dummy0
lo
===DUMMY0-OPERSTATE===
down
===ROUTE-COUNT===
0
===NPROC===
2
===MEMTOTAL===
MemTotal:         491908 kB
===EGRESS===
blocked: ENETUNREACH
===VSOCK===
vsock connect OK (cid=2 port=1234)
vsock round-trip OK, host replied: PONG from host gateway (uid=1000)
===WORKMOUNT===
total 16
drwxr-xr-x  2 node node 4096 Jul 22 22:43 .
drwxr-xr-x 18 node node 4096 Jul 25 04:14 ..
-rw-r--r--  1 node node   10 Jul 22 22:43 README.md
-rw-r--r--  1 node node   22 Jul 22 22:43 sample.js
console.log('hello');
===WORKMOUNT-WRITE-ATTEMPT===
touch: cannot touch '/work/should-fail': Read-only file system
good-read-only
===DONE===
=== magpie-krun-launch exited with status 0 ===
=== host listener log ===
host: listening on /tmp/magpie-krun-smoke.mnCgAm/gw.sock
host: received b'PING from rust guest\n'

=== automated assertions ===
PASS: dummy0 is administratively down
PASS: route table is empty
PASS: egress connect() is blocked, not a hang
PASS: vsock round-trip completed
PASS: guest uid is root despite krun_setuid (see src/krun.rs)
PASS: /work virtiofs mount succeeded and is visible
PASS: /work is read-only (write attempt failed)
PASS: host listener actually received the guest's vsock PING

ALL ASSERTIONS PASSED
```
Reproduced on a second independent run with identical results (different tmp paths only).
`nproc=2`/`MemTotal≈480MiB` confirm VMM-enforced vcpu/RAM (requested 2/512, not the host's own
values) — the structural fix for `bug_df2d`'s CPU/RAM sibling issue.

**Build/test/lint commands run and results** (all from `rust/`):
- `cargo build -p magpie-microvm-launcher` — OK.
- `cargo build -p magpie-microvm-launcher --release` — OK; `file`/`ldd` confirm dynamic linking
  against `libkrun.so.1` as designed (not the workspace's usual static-musl form).
- `cargo test -p magpie-microvm-launcher` — 49 passed, 0 failed, no VM/KVM needed.
- `cargo clippy -p magpie-microvm-launcher --all-targets -- -D warnings` — clean, 0 warnings.
- `cargo fmt --check -p magpie-microvm-launcher` — clean after one `cargo fmt` pass (formatting
  only, no logic changes).
- Whole-workspace sanity: `cargo fmt --check` (no exclude needed), `cargo clippy --workspace
  --exclude magpie-microvm-launcher --all-targets -- -D warnings`, `cargo test --workspace
  --exclude magpie-microvm-launcher` (5 vsock-framing tests pass, unaffected), `cargo build
  --release --workspace --exclude magpie-microvm-launcher --target aarch64-unknown-linux-musl` —
  all clean, confirming the CI exclusion wiring in `rust.yml` is correct and the rest of the
  workspace is untouched.

**Known gaps / what C3 (`task_39ff`) needs to do:**
1. **Guest confinement is not solved.** The guest boots as root regardless of `krun_setuid`/
   `krun_setgid`. `task_39ff` (or a preceding image change) needs an `su-exec`/`setpriv`
   self-drop in the reviewer image's own entrypoint before it execs Pi, or this launcher's
   non-root guarantee is weaker than the current `docker run --user` posture (itself already a
   defence-in-depth-only guarantee, per `container-mounts.ts`'s doc comments — the mount/uid
   design there assumes the container UID equals the orchestrator's own).
2. **Mounting `/work` inside the guest is not this launcher's job.** It attaches the virtiofs
   device; something guest-side must `mount -t virtiofs <tag> <path>` before using it (the smoke
   test does this inline in `smoke-probe.sh`; a real entrypoint would need the same first step).
3. **No orchestrator wiring at all** (by design/scope) — `reviewer.ts`/`container-mounts.ts` are
   untouched. `task_39ff` needs to: replace `buildReviewDockerArgs`'s docker invocation with this
   binary's CLI contract; decide how the orchestrator supplies `--rootfs` (a persistent unpacked
   image vs. per-job `podman export`); wire the per-job gateway vsock uds path in place of
   `gatewaySocketDir`'s bind-mounted directory; and decide whether/how `findMissingHardenedFlags`'s
   preflight-invariant pattern gets a libkrun-shaped equivalent.
4. **amd64 untested** (no hardware — same caveat the spike carried forward).
5. **`krun_add_virtiofs3`'s DAX/`shm_size` parameter is passed as `0`** (no DAX window) — untuned;
   fine for this task's correctness goals but a performance question for later if `/work` I/O
   turns out to matter.
6. **No dedicated CI for this crate.** Excluded from `rust.yml`'s shared jobs (see the dynamic-link
   section above); a libkrun-equipped self-hosted runner is real future work, not done here.
