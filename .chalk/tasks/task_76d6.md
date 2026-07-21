---
id: task_76d6
title: M8-C0: host-side micro-VM launcher — direct libkrun (TSI-off no-network + per-VM vsock gateway port + setuid + vcpu/RAM)
type: task
status: open
priority: 1
labels: [rust,microvm,libkrun]
blocked_by: [decision_06c2,task_08ec]
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-21T21:39:41Z
updated_at: 2026-07-21T21:39:47Z
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
- [ ] Rust binary in the cargo workspace (RUST-2 / `task_2a18`); binds the libkrun C ABI (bindgen
      or hand-written `extern "C"`, wrapped in a safe module). Pin libkrun to a known ABI (spike
      used v1.19.4 = ABI 1; crun-independent here, but pin it).
- [ ] Owns the reviewer launch contract today in `reviewer.ts`/`container-mounts.ts`: read-only
      `/work`, per-job gateway socket, non-root, resource caps — mapped to the calls above.
- [ ] Spawned by the orchestrator as a subprocess exactly where `docker run` is invoked today
      (`reviewer.ts`); JSON/NDJSON stdout contract preserved so `findings.ts` is unchanged.
- [ ] OCI-image→rootfs prep: net-new work podman gives for free today. Decide unpack-to-dir
      (spike used `podman export` + virtiofs) vs `krun_set_root_disk` ext4 image (brief §6.2).
      Feeds `task_08ec` and the effort estimate.
- [ ] Secret split (epic_59b1 CTO edit 1, MERGE BLOCKER): the launcher is orchestrator-side; it
      must NOT hold the provider key. The gateway keeps its own uid; its per-job socket is handed
      to the VM via `krun_add_vsock_port2`. Preserve orchestrator ⟂ gateway uid separation.
- [ ] `/dev/kvm` access via the group + `keep-groups` path proven in the spike (no setfacl, no
      0666) — but note: outside podman we manage the userns/kvm access ourselves; confirm the
      rootless-launcher path to `/dev/kvm`.
- [ ] Unit tests (Rust) for arg/config assembly; boundary behaviour via the RUST-3 contract suite
      (`task_9d2b`) and the reviewer-launch e2e tests.

Relationship to other tasks:
- Supersedes the `podman --runtime krun` approach in `task_39ff` (M8-C3), which now builds on this
  launcher. `task_39ff` should be re-scoped accordingly when it's picked up.
- Realises `task_3b48` (no-network) and provides the host end of `task_a163`/`task_b3f7`.
- Gated on `decision_06c2` (libkrun go/no-go) and `task_08ec` (rootless substrate).

Done when: the launcher boots the real reviewer image as a rootless micro-VM with TSI-off
no-network, a working per-VM gateway vsock channel, VMM-enforced vcpu/RAM, and the read-only
`/work` contract — driven by the orchestrator in place of `docker run`, with the secret split
intact.
