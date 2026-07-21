---
id: task_1fdc
title: M8-A1: libkrun-under-rootless-Podman spike — timeboxed 2 weeks incl. 16 KB-page arm64
type: task
status: in_progress
priority: 1
labels: [spike,gate,microvm]
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:53:33Z
updated_at: 2026-07-19T23:05:19Z
---
The single pre-implementation gate (brief §7.1), approved with a HARD TIMEBOX: two weeks total,
including the 16 KB-page arm64 box (the hardest case). The question it answers: does libkrun/krun
behave as a drop-in OCI runtime under rootless Podman for our existing mount/env/argv contract?

Checklist:
- [ ] Rootless podman + krun boots the existing magpie-reviewer OCI image as a micro-VM guest on
      a representative amd64 host.
- [ ] Same on the 16 KB-page arm64 box (libkrun's bundled aarch64 guest kernel is
      CONFIG_ARM64_4K_PAGES=y; KVM stage-2 granule is independent of guest stage-1 — confirm in
      practice, not just in theory).
- [ ] /dev/kvm access via kvm-group membership; carry crun #1894 — if krun needs more, prefer
      setfacl -m u:<svc>:rw /dev/kvm; world-0666 is a real permission regression and is NOT
      acceptable.
- [ ] Read-only virtiofs /work mount of a PR checkout works for Pi's read tools.
- [ ] Confirm the guest-vCPU ceiling and measure boot-to-userspace on the real reviewer rootfs.
- [ ] Confirm guest RAM ceiling is VMM-enforced (memory-bomb containment) as validated for
      Firecracker in the brief appendix.
- [ ] Write up pass/fail against each gate item in this task file.

Decision rule on failure: STOP — see the companion decision task. Do NOT start Firecracker-direct
work. Timebox expiry without a pass counts as a fail for the decision rule.

Done when: written pass/fail spike report exists here and the go/no-go decision task is
unblocked with evidence.

---

## Plan (2026-07-20) — timebox expires 2026-08-03

Branch: `m8-a1-libkrun-spike`. Spike artifacts land under `spike/m8-a1/` (throwaway; strip-or-keep
is a pre-merge decision like M7's `spike/m7-0/`). Nothing in `packages/` is touched by this task —
a spike that needs to edit production code has already answered its own question wrong.

### Phase 0 — read-only recon (no installs)
- [ ] Confirm this host's actual page size, arch, and kernel (`getconf PAGESIZE`, `uname -m -r`).
      Working assumption: RPi 5 / BCM2712 / `rpt-rpi-2712` = arm64 @ 16 KB pages — i.e. this host
      IS the hard case in checklist item 2, so no separate arm64 box needs provisioning.
- [ ] Confirm KVM is actually exposed: `/dev/kvm` present, its group/mode, whether the current
      user is in `kvm`, and that the CPU/kernel report virtualisation support. **If `/dev/kvm`
      does not exist on this kernel the spike cannot run here at all** — that is a host-provisioning
      problem, NOT a libkrun fail, and must not be recorded against the decision rule.
- [ ] Inventory what's already installed: `podman`, `crun`, `krun`, `buildah`, and whether the
      distro's `crun` was built with the libkrun handler (`crun --version` feature list).
- [ ] Confirm the reviewer image is pullable/present locally (the digest pinned in
      `config.example.toml`) — the spike must boot the REAL image, not a hello-world.

### Phase 1 — toolchain (first invasive step)
- [ ] Install rootless Podman + its deps (`podman`, `uidmap`/subuid-subgid, `slirp4netns`/`passt`,
      `fuse-overlayfs`).
- [ ] Obtain a krun-capable runtime. Expect this to require **building from source**: Debian/RPi OS
      does not ship `libkrun`, and stock `crun` is generally built WITHOUT `--with-libkrun`. So:
      build `libkrun` (+`libkrunfw`, which carries the bundled guest kernel), then build `crun`
      with the krun handler and install it as the `krun` binary.
- [ ] Record every install/build step as a script under `spike/m8-a1/` — the D-phase installer
      task (`task_67aa`) inherits this, and "what did we actually have to do to the host" is half
      the value of this spike.
- [ ] **Snapshot host state before/after** (installed packages, `/dev/kvm` mode+ACL, group
      membership) so the changes are reversible and auditable.

### Phase 2 — the gate question: does it boot?
- [ ] `podman --runtime krun run` the real `magpie-reviewer` image as a micro-VM guest, rootless.
- [ ] The 16 KB-page question, empirically: libkrun's bundled aarch64 guest kernel is
      `CONFIG_ARM64_4K_PAGES=y`, and KVM's stage-2 granule is independent of the guest's stage-1,
      so it *should* boot on a 16 KB host. Confirm in practice. **If it fails, capture the exact
      failure mode** (libkrunfw kernel refusing to boot vs. crun handler error vs. KVM ioctl
      rejection) — the distinction decides whether a rebuilt 16 KB-aware `libkrunfw` is a cheap
      fix or whether this is the genuine fail the decision rule contemplates.
- [ ] `/dev/kvm` access: try `kvm`-group membership FIRST. Only if that's insufficient (crun #1894)
      try `setfacl -m u:$(id -un):rw /dev/kvm`. **World-`0666` is not an acceptable outcome** — if
      only that works, it is recorded as a fail on this checklist item, not as a workaround.

### Phase 3 — does our contract survive the swap?
The real question isn't "a VM boots", it's "libkrun is a drop-in for our existing mount/env/argv
contract". Test against what `reviewer.ts` + `container-mounts.ts` actually pass today:
- [ ] Read-only virtiofs `/work` mount of a real PR checkout; verify Pi's read tools
      (`read,grep,find,ls`) work across it and that writes are genuinely rejected.
- [ ] Env/argv passthrough (the per-job virtual key is injected as env today).
- [ ] Which of today's hardening flags (`--cap-drop=ALL`, `--read-only`, `--pids-limit`,
      non-root user) are honoured, silently ignored, or rejected under krun. Silent-ignore is the
      dangerous case and is what `task_89c4`'s floor-invariant test exists to catch.
- [ ] Note (do NOT solve here): no-network assertion and vsock are separate tasks
      (`task_3b48`, `task_a163`). Scope discipline — this task is the boot/contract gate only.

### Phase 4 — limits and measurements
- [ ] Guest RAM ceiling is **VMM-enforced**: run a memory bomb in-guest, confirm it dies inside
      the VM without the host OOM-killer firing. This directly de-risks the open `bug_df2d`
      (host cgroup `--memory` silently unenforced) — a VMM-enforced ceiling is structurally
      better than the cgroup limit that bug is about, so record the result there too.
- [ ] Guest vCPU ceiling.
- [ ] Boot-to-userspace timing on the real reviewer rootfs, several runs — this is per-review
      latency added to every PR, so a slow number is a product finding, not just a stat.

### Phase 5 — write up and hand off
- [ ] Explicit PASS/FAIL per checklist item in this file, with the evidence inline. Partial
      passes get recorded as partial, not rounded up.
- [ ] On PASS: unblock `decision_06c2` with the evidence; `task_a163` (vsock) becomes the next gate.
- [ ] On FAIL: **stop.** Write the failure analysis into `decision_06c2` per the CTO rule. Do NOT
      start Firecracker-direct work and do NOT create Firecracker implementation tasks.
- [ ] Update `LEARNINGS.md`.

## Interim findings (2026-07-20, Phase 0–1 complete, Phase 2 in progress)

### Phase 0 — host recon: PASS, and this host IS the hard case
- Raspberry Pi 5 Model B Rev 1.0, `aarch64`, kernel `6.12.93+rpt-rpi-2712`,
  **`getconf PAGESIZE` = 16384**. This is precisely the 16 KB-page arm64 box checklist item 2
  targets, so that leg needs no separate provisioning.
- **KVM is available**: `/dev/kvm` present as `crw-rw---- root:kvm`, `kvm` module loaded. Plan
  risk #2 (RPi 5 might not expose KVM) is retired.
- **`operator` was NOT in the `kvm` group** (groups: pi, adm, dialout, cdrom, sudo, audio, video,
  plugdev, games, users, input, render, netdev, docker, gpio, i2c, spi). Group add pending;
  preferred path per checklist, `setfacl` remains fallback only.
- Rootless substrate already largely present: podman 4.3.1, crun 1.8.1, buildah, slirp4netns,
  newuidmap, and `/etc/subuid`+`/etc/subgid` already delegate `operator:100000:65536`.

### Phase 1 — toolchain: two distribution findings, both pre-date the boot question
1. **Stock `crun` cannot drive libkrun.** Debian's crun 1.8.1 reports
   `+SYSTEMD +SELINUX +APPARMOR +CAP +SECCOMP +EBPF +YAJL` — no krun handler, and no `krun`
   binary exists. A source build of `crun --with-libkrun` is mandatory.
2. **Debian's Rust is too old by a wide margin.** libkrun's crates declare `edition = "2024"`
   (needs rustc >= 1.85); bookworm ships **1.63**. rustup is therefore mandatory — installed
   1.97.1.
3. **libkrunfw compiles a full Linux kernel from source** (6.12.91 at spike time; 141 MB tarball,
   long build on a Pi).

Taken together these mean a self-hoster adopting the micro-VM tier must install rustup, compile a
kernel, and build two C projects — **this is plan risk #3 confirmed as fact, independent of
whether the boot succeeds.** It materially affects M8-D packaging (`task_67aa`) and the effort
estimate. Steps captured in `spike/m8-a1/provision.sh`.

### Unplanned finding — `bug_df2d` reproduced live, with root cause
The first baseline run failed hard:
`crun: opening file 'memory.max' for writing: No such file or directory`.
Root cause: **`cgroup_disable=memory` is in this host's `/proc/cmdline`** (a Raspberry Pi OS
default). `/sys/fs/cgroup/cgroup.controllers` = `cpuset cpu io pids` — the memory controller does
not exist at all, and `/proc/cgroups` has no memory row.

Two things worth recording against `bug_df2d`:
- **Podman/crun fails CLOSED here where docker fails OPEN.** Today's docker path silently ignores
  the unenforced `--memory` (that is exactly what `bug_df2d` reports); podman refuses to start the
  container. Fail-closed is the better behaviour and is an argument for the B-phase port
  (`task_08ec`) beyond rootlessness alone.
- **The micro-VM tier structurally fixes this.** A VMM-enforced guest RAM ceiling does not depend
  on host cgroup availability at all, so the M8 target architecture removes the whole failure
  mode rather than patching it. Worth adding to the CTO brief's argument for M8.
- Caveat for Phase 4: the memory-bomb containment test **cannot be run against the crun floor on
  this host** without enabling the memory cgroup (edit `/boot/firmware/cmdline.txt` + reboot —
  not done, needs approval). The micro-VM leg of that test is unaffected.

### Baseline — rootless podman + stock crun honours today's full contract: PASS
Control data for Phase 3, using the exact flag set from `reviewer.ts:364-373`
(`--user`, `--read-only`, `--tmpfs /tmp`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`,
`--cpus`, `--pids-limit`, `--network none`, `-v …:/work:ro`), against the real pinned
`reviewer:0.2.0@sha256:e6a6e11…` image (pulled; the local `0.1.0` was stale and was NOT used):

| check | result |
|---|---|
| runs as non-root `uid=1000 gid=1000` | PASS |
| `/work` readable | PASS |
| `/work` write rejected | PASS |
| container rootfs write rejected | PASS |
| `/tmp` tmpfs writable | PASS |
| network namespace has only `lo` | PASS |

Only `--memory` had to be dropped, for the cgroup reason above. This is a strong early signal for
`task_08ec` (docker→rootless podman port): the hardening contract survives the runtime swap
unchanged, so the B-phase risk is lower than the brief assumed.

## SPIKE RESULT: PASS, with contract caveats that need a follow-up task

**The gate question is answered: yes.** libkrun/krun boots the real pinned reviewer image as a
rootless micro-VM on this 16 KB-page arm64 host. Per the CTO decision rule, `decision_06c2` should
record a PASS and the C-phase may proceed on libkrun. **However**, "it boots" is not the same as
"drop-in for our mount/env/argv contract" — three production flags are *silently ignored*, which
needs handling before the C-phase port lands.

### The 16 KB-page question — PASS, empirically
```
guest-kernel=6.12.91   pagesize=4096   (host: 6.12.93+rpt-rpi-2712, pagesize=16384)
```
Guest kernel config confirmed `CONFIG_ARM64_4K_PAGES=y`. The brief's theory held: KVM's stage-2
granule is independent of the guest's stage-1, so a 4 KB guest boots on a 16 KB host. The `uname`
differing from the host is itself the proof this is a real VM guest, not a container.

### `/dev/kvm` access — PASS, and better than the checklist feared
No `setfacl` needed and **no world-`0666`**. The working combination is:
`sudo usermod -aG kvm <svc>` **plus podman's `--group-add keep-groups`**.
Root cause of the initial `Error creating the Kvm object: Error(13)` (EACCES): rootless podman
drops supplementary groups inside the user namespace, so `kvm` membership alone is not enough and
`--device /dev/kvm` alone does not fix it. `keep-groups` retains the membership across the userns
boundary. **crun #1894 does not bite us** — record this for `task_67aa` (installer).

### Per-checklist verdicts
| checklist item | verdict | evidence |
|---|---|---|
| boots on representative **amd64** host | **NOT TESTED** | no amd64 hardware available; see gap below |
| boots on **16 KB-page arm64** | **PASS** | 4 KB guest on 16 KB host, above |
| `/dev/kvm` via kvm-group, no 0666 | **PASS** | group + `keep-groups`; no ACL needed |
| read-only virtiofs `/work` | **PASS** | reads OK, `touch /work/EVIL` rejected |
| guest-vCPU ceiling + boot timing | **PASS** | `krun.cpus=2`→nproc=2 (see caveats); timing below |
| guest RAM ceiling VMM-enforced | **PASS** | containment test below |
| written pass/fail per item | **DONE** | this section |

### Boot-to-userspace on the real reviewer rootfs
5 runs each, real image, `/work` mounted:
- **krun micro-VM:** 3.98 / 5.57 / 5.69 / 6.38 / 7.08 s (median ≈ 5.7 s)
- **crun baseline:** 3.26 / 3.40 / 3.71 / 4.34 / 4.49 s (median ≈ 3.7 s)

**≈ +2 s per review.** Against multi-minute review runs this is a non-issue. (Pi 5 numbers; a
server host will be faster.)

### Guest RAM containment — PASS, and it fixes `bug_df2d` structurally
Guest `MemTotal ≈ 1005 MB` (libkrun default; **not** derived from `--memory` — see caveat 3).
A Node memory bomb allocating 64 MB chunks died in-guest at ~512 MB. **Host (8 GB) saw no OOM
event at all.** This is the key structural result: the RAM ceiling is enforced by the VMM and
holds *even though this host's memory cgroup is disabled entirely* (`cgroup_disable=memory`). The
micro-VM tier therefore removes `bug_df2d`'s failure mode rather than patching it — worth adding
to the brief's argument for M8.

### ⚠ Contract caveats — RESOLVED for 2 of 3; the podman flags were the wrong lever
Follow-up investigation (2026-07-21, two sonnet agents: empirical + upstream; full report in
`spike/m8-a1/flag-investigation.md`) established that vCPU and RAM are configured through
**krun-specific OCI annotations**, not the container-shaped podman flags. crun's krun handler
(`crun/src/libcrun/handlers/krun.c:259-277`) reads `krun.cpus` / `krun.ram_mib` and, for CPU,
never even looks at `resources.cpu` (the quota `--cpus` sets); documented in `crun/krun.1.md`.

1. **vCPU — SOLVED. Lever: `--annotation krun.cpus=N`.** VERIFIED on this host:
   `--annotation krun.cpus=2` → guest `nproc=2` (vs 4 with `--cpus=2`). `--cpus` writes a cgroup
   `cpu.max` the handler ignores; it otherwise falls back to `sched_getaffinity()`.
2. **RAM — SOLVED, and this is the clean fix for `bug_df2d` on the microVM path. Lever:
   `--annotation krun.ram_mib=N`.** VERIFIED: `--annotation krun.ram_mib=2048` → guest
   `MemTotal ≈ 2033 MB`, **with no `--memory` flag and no host memory cgroup present.** The
   annotation sizes guest RAM directly inside the VMM, bypassing cgroups entirely. `--memory` must
   NOT be passed under krun (podman applies the cgroup write unconditionally before the handler
   runs, so it hard-errors on this cgroup-disabled host regardless). C-phase action: map
   `config.container.{cpus,memory}` to `krun.cpus` / `krun.ram_mib` annotations and stop emitting
   `--cpus`/`--memory` on the krun path.
3. **`--user` — genuinely NOT fixable via runtime config; confirmed a real libkrun limitation.**
   The host-side VMM process *does* drop to the mapped rootless uid correctly
   (`crun/src/libcrun/container.c:1674`, verified via `ps`). But the **guest's own init**
   (`libkrun/src/init_blob/init/init.c`) never reads user/uid/gid from the OCI config and never
   calls setuid — exhaustive grep, zero hits. libkrun's C API exposes `krun_setuid`/`krun_setgid`
   but crun's handler never calls them (upstream gap, not our misuse). So the guest workload runs
   as `uid=0` inside the VM. Blast radius is the guest VM, not a shared kernel. **Recommended
   mitigation: have the reviewer image's own entrypoint self-drop privileges (e.g. `su-exec`)
   before exec'ing Pi** — that code runs as guest-root under our control regardless of krun, and
   restores non-root execution of the untrusted-input-handling process. Cheap, in our image, and
   worth doing so the defence-in-depth posture matches today's.

### ⚠ `--network none` is NOT a bare netns under krun
The guest has **`dummy0` plus a route to `203.0.113.0/24`** (RFC 5737 TEST-NET-3) — libkrun's TSI
(transparent socket impersonation) scaffolding — even with `--network none`.

Egress was **empirically blocked** (`net.connect` to `1.1.1.1:443` → `ENETUNREACH`, identical to
the crun baseline), so this is not a live escape. **But the mechanism is weaker than M7's
guarantee, and the follow-up confirmed there is no cheap runtime fix.** TSI (transparent socket
impersonation) is libkrun's *default*, auto-enabled whenever no explicit net device is added
(`libkrun/src/libkrun/src/lib.rs:2954`: `enable_tsi = net.list.is_empty() && …`), and crun's
handler only ever adds a device via the opt-in `krun.use_passt` annotation — which switches
backend, doesn't disable networking. **No annotation, public API, or Cargo feature reachable
through crun turns TSI off in v1.19.4.** (libkrun's C API *does* expose the knobs —
`krun_add_vsock(ctx_id, 0)` or `krun_add_net_tap` disable TSI per the header — but crun never
calls them.) So egress rests on "an interface exists but has no route there," a
configuration-dependent property, where M7's Design D rests on "no interfaces exist, a property of
the namespace." `task_3b48` (TSI off + fail-closed in-guest assertion) is therefore **load-bearing
and a C-phase merge blocker**, and closing it will require a patched/forked krun handler (call
`krun_add_vsock(ctx_id, 0)`) rather than configuration — a real, non-trivial scope item the CTO
should see now.

### Additional packaging findings for `task_67aa`
- **crun/libkrun ABI skew:** crun HEAD `dlopen`s `libkrun.so.1`, but libkrun HEAD builds ABI 2
  (`libkrun.so.2`) → `failed to open libkrun.so.1`. Fixed by building **libkrun `v1.19.4`**
  (ABI 1). Both must be version-pinned together; tracking two HEADs breaks.
- `libkrun` installs to `/usr/local/lib64`, which is **not** on Debian's linker path; needs an
  `/etc/ld.so.conf.d/` entry + `ldconfig`.
- Extra build deps beyond the first pass: `libclang-dev`/`clang` (bindgen), `libjson-c-dev`,
  `autoconf automake libtool libyajl-dev libseccomp-dev libcap-dev libsystemd-dev go-md2man`.
- `krun` is installed as a **symlink to `crun`**; the handler activates on `argv[0]`.

### Gap: amd64 leg NOT tested
Per the session decision, the spike ran arm64-only — no amd64 hardware was available. The 16 KB
arm64 box was the *harder* case and it passed, so amd64 is lower-risk, but it is formally
untested and the CTO should accept or reject that explicitly before the C-phase.

### Risks / open questions
1. **amd64 coverage is not satisfiable on this host.** Checklist item 1 wants a representative
    amd64 box; we only have arm64 here. Options: run the amd64 leg in CI (GitHub-hosted runners
    are amd64 but **do not expose nested KVM**, so this likely does NOT work), use a cloud VM with
    nested virt enabled, or have the CTO accept arm64-16K-only evidence for the gate. Needs a call.
2. **RPi 5 KVM availability is unverified** — if this kernel doesn't expose `/dev/kvm`, Phase 0
    ends the spike here and we need a different arm64 box.
3. **Build-from-source burden is itself a finding.** If shipping this means every self-hoster
    builds libkrun+crun from source, that is a distribution problem for M8-D and materially
    affects the effort estimate, independent of whether the boot succeeds.
