//! `magpie-krun-launch` — the production host-side micro-VM launcher (M8-C0
//! / `task_76d6`).
//!
//! # Why this exists
//!
//! Magpie's reviewer today runs as a hardened `docker run` container (see
//! `packages/orchestrator/src/reviewer.ts`). M8 replaces that with a
//! rootless libkrun micro-VM for structurally stronger isolation (VMM-
//! enforced RAM instead of a cgroup that can be silently disabled —
//! `bug_df2d` — and a real hypervisor boundary instead of shared-kernel
//! namespaces). The M8-A1 spike (`spike/m8-a1/frontend-investigation.md`)
//! found that driving libkrun through `podman --runtime krun` (crun's krun
//! handler) cannot reach the calls this posture needs — TSI stays on
//! (`spike/m8-a1/flag-investigation.md` §4), `--user` never reaches the
//! guest, and there is no lever for the per-VM gateway vsock channel. So
//! this binary links libkrun directly and makes those calls itself.
//!
//! # What this launcher does and does not own
//!
//! This is a **standalone** binary, deliberately not wired into the
//! orchestrator (`packages/orchestrator/src/reviewer.ts` is untouched — see
//! the task's confirmed scope). It owns:
//!   - The libkrun call sequence (`src/krun.rs`): vcpu/RAM, root filesystem,
//!     the read-only `/work` virtiofs device, TSI-off, the per-VM gateway
//!     vsock port, uid/gid, and the exec/env/workdir contract.
//!   - Argv parsing and validation (`src/cli.rs`, `src/config.rs`).
//!
//! It does NOT own:
//!   - Mounting the `/work` virtiofs device INSIDE the guest (`mount -t
//!     virtiofs <tag> <path>`) — that's the exec target's job (see
//!     `LaunchConfig::work_mount`'s doc comment). The reviewer image's own
//!     entrypoint would need to do this as one of its first actions once
//!     this launcher is wired in (`task_39ff`).
//!   - Confining the guest's own uid/gid — `krun_setuid`/`krun_setgid` only
//!     drop the HOST-side VMM process; the guest is always root today (see
//!     `src/krun.rs`'s module doc comment for the full finding and its
//!     evidence). An image-side `su-exec` mitigation is the real fix, also
//!     out of this launcher's scope.
//!   - Minting/revoking the per-job gateway virtual key, preparing the host
//!     mount directories, or any orchestrator business logic — this binary
//!     only consumes already-prepared paths/ids via its CLI contract.
//!
//! # `/dev/kvm` access — the rootless path
//!
//! `/dev/kvm` on a typical host is `crw-rw---- root:kvm` (confirmed on this
//! dev host and recorded in `spike/m8-a1/provision.sh` step 3/correction
//! (d)). This launcher needs no special privilege beyond that: run it as a
//! user who is a MEMBER OF THE `kvm` GROUP (`sudo usermod -aG kvm
//! <service-user>`, then a re-login/`newgrp kvm`/`sg kvm` for the group to
//! take effect in the current session — group membership changes don't
//! retroactively apply to already-running sessions). That's it: no
//! `setfacl`, and definitely no `chmod 0666 /dev/kvm` (the spike explicitly
//! records a world-writable `/dev/kvm` as a FAIL on its own checklist, not
//! an acceptable fallback).
//!
//! Unlike the spike's podman-based experiments (which additionally needed
//! podman's own `--group-add keep-groups`, because rootless podman drops
//! supplementary groups in its user namespace by default), this launcher is
//! a **plain host process** with no container/namespace layer of its own
//! between it and `/dev/kvm` — group membership alone is sufficient, which
//! is what every invocation in this crate's own smoke test
//! (`smoke-test.sh`) and unit-test-adjacent manual runs relied on.
//!
//! One real wrinkle THIS launcher surfaces that the podman-fronted spike
//! did not: `krun_setuid`/`krun_setgid` (see `src/krun.rs`) apply a plain
//! `setuid(2)`/`setgid(2)` to the CURRENT process, and POSIX only allows an
//! unprivileged caller to set its uid/gid to one it ALREADY holds as its
//! real/effective/saved id — not merely a supplementary group. Concretely:
//! running this launcher via `sg kvm -c '...'` (the standard way to pick up
//! `kvm`-group membership without a re-login) changes the invoking shell's
//! real/effective/saved GID to `kvm`'s gid for that command; `--gid` must
//! then be the CURRENT (post-`sg kvm`) gid, not whatever `id -g` reported
//! before entering that context, or `krun_start_enter` fails closed with
//! `EPERM` before the VM ever starts (empirically hit and documented in
//! `smoke-test.sh`'s comments). In production this launcher is expected to
//! run as a long-lived service process whose primary group already IS `kvm`
//! (or that otherwise doesn't need `sg`/`newgrp` per invocation), which
//! avoids this wrinkle entirely — it's specific to ad-hoc/interactive
//! invocation, not the production shape.
//!
//! # Exit codes
//!
//! - `0` — unreachable in practice: a successful boot ends the process via
//!   libkrun's own `exit()` (see `krun::boot`'s doc comment), never by
//!   returning here.
//! - `0` — `--help` (usage requested, not an error).
//! - `2` — a CLI/argv parsing problem (missing/unknown flag, bad integer).
//! - `3` — a validated-but-rejected config value (non-ASCII cmdline
//!   content, root uid/gid, out-of-range vcpu/RAM, unpaired vsock flags).
//! - `4` — a libkrun call failed before the VM ever started, or the
//!   pre-boot `RLIMIT_NOFILE` raise failed.

mod cli;
mod config;
mod krun;

use std::process::ExitCode;

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();

    let parsed = match cli::parse(argv) {
        Ok(parsed) => parsed,
        Err(cli::CliError::HelpRequested) => {
            print!("{}", cli::USAGE);
            return ExitCode::SUCCESS;
        }
        Err(err) => {
            eprintln!("magpie-krun-launch: {err}");
            eprint!("{}", cli::USAGE);
            return ExitCode::from(2);
        }
    };

    let config = match parsed.validate() {
        Ok(config) => config,
        Err(err) => {
            eprintln!("magpie-krun-launch: invalid configuration: {err}");
            return ExitCode::from(3);
        }
    };

    eprintln!(
        "magpie-krun-launch: booting rootfs={:?} exec={:?} vcpus={} ram_mib={} uid={} gid={} \
         vsock={} work_mount={} (libkrun ABI: {})",
        config.rootfs,
        config.exec_path,
        config.vcpus,
        config.ram_mib,
        config.uid,
        config.gid,
        config
            .vsock_gateway
            .as_ref()
            .map(|g| g.port.to_string())
            .unwrap_or_else(|| "none".to_string()),
        config
            .work_mount
            .as_ref()
            .map(|m| m.tag.as_str())
            .unwrap_or("none"),
        krun::LIBKRUN_ABI_PIN,
    );

    // `krun::boot` does not return on success (see its doc comment) — the
    // guest's own stdout/stderr pass through this process unchanged (no
    // console redirection is configured), and libkrun calls exit() with the
    // guest's exit code once it's done. Reaching this line at all means
    // libkrun rejected the configuration before ever starting the VM.
    match krun::boot(&config) {
        Ok(never) => match never {},
        Err(err) => {
            eprintln!("magpie-krun-launch: boot failed: {err}");
            ExitCode::from(4)
        }
    }
}
