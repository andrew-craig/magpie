//! Pure, validated launch configuration — no `extern "C"`, no libkrun
//! linkage, no I/O. Everything in this module is exercised by plain `cargo
//! test` with no `/dev/kvm` and no libkrun present at *runtime* (the crate as
//! a whole still links libkrun at *build* time — see the crate's Cargo.toml
//! doc comment — but nothing in this file calls into it).
//!
//! [`LaunchConfig`] is the validated, security-relevant shape [`crate::cli`]
//! parses argv into and [`crate::krun`] consumes to drive the actual boot.
//! Validation lives here, not in `cli.rs`, so the same checks apply
//! regardless of how a `LaunchConfig` gets constructed (argv today; nothing
//! stops a future caller building one programmatically, e.g. a test harness
//! or an eventual orchestrator wiring in `task_39ff`).

use std::fmt;
use std::path::PathBuf;

/// Maximum vCPUs libkrun supports (`LIBKRUN_MAX_VCPUS` in libkrun's own
/// source — confirmed against `spike/m8-a1/flag-investigation.md` §1's
/// `sched_getaffinity` fallback, which caps at this same constant). Rejecting
/// out-of-range values here rather than letting `krun_set_vm_config` fail
/// deep inside the boot sequence gives a clear error before any FFI call.
pub const MAX_VCPUS: u8 = 16;

/// Floor for guest RAM. Mirrors `LIBKRUN_MINIMUM_RAM_MIB`, the same constant
/// `spike/m8-a1/flag-investigation.md` §2 documents crun's krun handler
/// falling back past (any `krun.ram_mib` at or below this is silently
/// replaced with the 1024 MiB default over there). This launcher calls
/// `krun_set_vm_config` directly rather than going through that annotation
/// path, but a caller-supplied value at or below this floor is almost
/// certainly a misconfiguration (e.g. a MiB/GiB mixup), so it's rejected
/// loudly here instead of silently upgraded.
pub const MIN_RAM_MIB: u32 = 128;

/// A virtiofs device attachment (`krun_add_virtiofs3`) — either the
/// read-only `/work` PR-checkout mount (`--work-mount`) or, as of task_39ff
/// (M8-C3), the WRITABLE `/out` findings mount (`--out-mount`). Reproduces
/// docker's two bind mounts (`-v <workspace>:/work:ro`, `-v <outDir>:/out`)
/// from `reviewer.ts`'s `buildReviewDockerArgs` — one struct, one field
/// (`read_only`) distinguishing the two, since `krun_add_virtiofs3`'s own
/// signature already takes a `read_only: bool` fourth argument (see
/// `krun.rs`) and everything else about the two mounts (host path + tag)
/// is identical in shape.
///
/// SCOPE NOTE: this struct only describes the HOST-side device attachment.
/// Actually mounting it inside the guest (`mount -t virtiofs <tag> <path>`)
/// is the guest workload's responsibility, not this launcher's — see the
/// crate root doc comment "What this launcher does and does not own".
/// `docker/reviewer/entrypoint.sh` does this mount (both `work` and `out`)
/// as one of its first actions under the micro-VM tier; this launcher's
/// smoke test mounts `work` inline in its `--exec` target to prove the
/// device wiring end-to-end (`out` is not exercised by that smoke test —
/// see its own doc comment).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkMount {
    /// Host directory attached into the guest.
    pub host_path: PathBuf,
    /// virtiofs tag the guest mounts by (`mount -t virtiofs <tag> <path>`).
    pub tag: String,
    /// Whether the guest's mount of this device is read-only
    /// (`krun_add_virtiofs3`'s `read_only` argument). `true` for
    /// `--work-mount` (the PR checkout must never be guest-writable — same
    /// invariant `container-mounts.ts`'s `assertGitStripped`/read-only bind
    /// mount enforce for the crun tier); `false` for `--out-mount` (the
    /// guest must be able to write `findings.json` back to the host).
    pub read_only: bool,
}

/// The per-VM HYBRID gateway vsock channel (`krun_add_vsock_port2`) — see
/// `RunReviewParams.gatewaySocketDir` in `reviewer.ts` for the docker-era
/// equivalent (a bind-mounted socket DIRECTORY). Under libkrun this is a
/// vsock PORT mapped to a single host-side unix socket PATH — never a
/// host-global listener, one per job/VM.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VsockGateway {
    /// vsock port the guest dials (`AF_VSOCK`, `VMADDR_CID_HOST`).
    pub port: u32,
    /// Host-side unix socket path libkrun connects out to when the guest
    /// dials `port` (`listen=false` — see `krun_add_vsock_port2`'s doc
    /// comment in `libkrun.h`: "true if guest expects connections to be
    /// initiated from host side"; we want the opposite, guest-initiated).
    pub uds_path: PathBuf,
}

/// Fully validated configuration for one micro-VM launch. Every field here
/// has already passed the checks in this module by the time a `LaunchConfig`
/// exists — `krun.rs`'s boot sequence trusts it without re-validating.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchConfig {
    /// Host directory used as the guest's root filesystem
    /// (`krun_set_root`) — an unpacked OCI rootfs (`podman export` to a
    /// directory, per this task's confirmed scope; NOT the `krun_set_root_disk`
    /// ext4-image path).
    pub rootfs: PathBuf,
    /// Number of vCPUs (`krun_set_vm_config`). VMM-ENFORCED, unlike the
    /// docker/crun `--cpus` flag this replaces (`bug_df2d`'s sibling issue
    /// for CPU — see `spike/m8-a1/flag-investigation.md` §1).
    pub vcpus: u8,
    /// Guest RAM in MiB (`krun_set_vm_config`). VMM-ENFORCED — the
    /// structural fix for `bug_df2d` (a cgroup-based memory limit that could
    /// be silently disabled; a VMM's RAM sizing cannot be).
    pub ram_mib: u32,
    /// uid passed to `krun_setuid`. NOTE: this configures the HOST-side VMM
    /// process's uid, not the guest's — see `src/krun.rs`'s module doc
    /// comment and this crate's smoke-test evidence for why. Still validated
    /// as non-root here as defence-in-depth on the host-side process.
    pub uid: u32,
    /// gid passed to `krun_setgid`. Same caveat as `uid` above.
    pub gid: u32,
    /// Guest-relative working directory (`krun_set_workdir`).
    pub workdir: String,
    /// Path to the executable inside the guest rootfs (`krun_set_exec`).
    pub exec_path: String,
    /// Arguments passed to `exec_path` (`krun_set_exec`'s `argv`).
    pub exec_args: Vec<String>,
    /// Environment variables injected into the guest process
    /// (`krun_set_exec`'s `envp`). `(KEY, VALUE)` pairs, already split.
    pub env: Vec<(String, String)>,
    /// The per-VM gateway vsock channel, if configured. `None` is a valid
    /// (if unusual) configuration — a VM with TSI off and no vsock port has
    /// no channel off itself at all, which is a stricter posture still
    /// useful for e.g. the no-network-only half of the smoke test.
    pub vsock_gateway: Option<VsockGateway>,
    /// The read-only `/work` virtiofs device, if configured.
    pub work_mount: Option<WorkMount>,
    /// The writable `/out` virtiofs device (task_39ff / M8-C3), if
    /// configured — how the guest hands `findings.json` back to the host;
    /// see `WorkMount::read_only`'s doc comment.
    pub out_mount: Option<WorkMount>,
}

/// Everything that can make a [`LaunchConfig`] (or its raw inputs) invalid.
/// Deliberately one flat enum rather than per-field error types — every
/// variant already carries enough context in its `Display` impl for a CLI
/// error message, and callers (currently just `main.rs`) don't need to
/// pattern-match on the specific field to do anything useful with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    /// A string bound for the guest's kernel command line (the exec path, an
    /// argv entry, or an env `KEY=VALUE`) contains a non-ASCII byte or a
    /// newline/carriage-return. Reproduces the exact failure class the spike
    /// hit: `spike/m8-a1/frontend-investigation.md`'s "Build note" — passing
    /// a multi-line script as argv panicked libkrun host-side with
    /// `InvalidAscii` at `builder.rs:1073` *before the guest ever booted*.
    /// Catching it here turns an opaque host panic into a clean, targeted
    /// error naming exactly which field and value was the problem.
    NotCmdlineSafe { field: &'static str, value: String },
    /// `uid`/`gid` was 0. The whole point of `krun_setuid`/`krun_setgid` is
    /// to run something other than root; a caller asking for uid/gid 0 has
    /// either made a mistake or is asking this launcher to defeat its own
    /// contract, so it's rejected rather than silently honoured.
    RootIdRejected { field: &'static str },
    /// `vcpus` was 0 or exceeded [`MAX_VCPUS`].
    VcpusOutOfRange { requested: u8 },
    /// `ram_mib` was at or below [`MIN_RAM_MIB`].
    RamTooLow { requested: u32 },
    /// Exactly one of `--vsock-port`/`--vsock-uds` was supplied. The pair is
    /// all-or-nothing: `krun_add_vsock_port2` needs both a port and a path,
    /// and a caller who supplied only one almost certainly meant to supply
    /// both (a typo/omission), so this fails closed rather than silently
    /// booting with no gateway channel.
    VsockPortUdsUnpaired,
    /// A host path handed to libkrun (`--rootfs` via `krun_set_root`, the
    /// `--work-mount` host path via `krun_add_virtiofs3`, or `--vsock-uds`
    /// via `krun_add_vsock_port2`) was relative. All three are resolved by
    /// libkrun in a different process/cwd context by the time
    /// `krun_start_enter` runs (and `--vsock-uds` is additionally a path a
    /// separate host-side forwarder must agree on), so a relative path would
    /// resolve against whatever cwd happens to be current — exactly the kind
    /// of ambiguity a per-job, security-relevant path in a fail-closed
    /// privileged component should never have. `field` names which one.
    PathNotAbsolute { field: &'static str, path: String },
    /// `rootfs` was empty or not an existing directory. Checked here (a pure
    /// string/path check on the value, not a filesystem stat — see the
    /// field doc below) so `--rootfs ""` fails the same way as any other bad
    /// input, at config-validation time rather than deep inside
    /// `krun_set_root`.
    RootfsEmpty,
    /// A `--work-mount`/`--out-mount` value was missing its host path.
    /// `field` names which flag (`"--work-mount"` or `"--out-mount"`).
    WorkMountEmpty { field: &'static str },
    /// A `--work-mount`/`--out-mount` value had an empty virtiofs tag (e.g.
    /// `/path:`). An empty tag is passed straight to `krun_add_virtiofs3`,
    /// attaching a device the guest cannot `mount -t virtiofs <tag>` by name
    /// — a silent misconfiguration this otherwise fail-closed component
    /// should reject up front rather than boot a VM whose `/work`/`/out` can
    /// never be mounted. `field` names which flag.
    WorkMountTagEmpty { field: &'static str },
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigError::NotCmdlineSafe { field, value } => write!(
                f,
                "{field} is not safe for libkrun's kernel-cmdline packing (must be plain ASCII, \
                 no newlines/carriage-returns): {value:?}"
            ),
            ConfigError::RootIdRejected { field } => {
                write!(
                    f,
                    "{field} must not be 0 (root) — this launcher's contract is a non-root guest"
                )
            }
            ConfigError::VcpusOutOfRange { requested } => {
                write!(f, "vcpus must be in 1..={MAX_VCPUS}, got {requested}")
            }
            ConfigError::RamTooLow { requested } => {
                write!(f, "ram_mib must be > {MIN_RAM_MIB}, got {requested}")
            }
            ConfigError::VsockPortUdsUnpaired => {
                write!(
                    f,
                    "--vsock-port and --vsock-uds must be supplied together (or not at all)"
                )
            }
            ConfigError::PathNotAbsolute { field, path } => {
                write!(f, "{field} must be an absolute path, got {path:?}")
            }
            ConfigError::RootfsEmpty => write!(f, "--rootfs must not be empty"),
            ConfigError::WorkMountEmpty { field } => write!(f, "{field} must not be empty"),
            ConfigError::WorkMountTagEmpty { field } => {
                write!(
                    f,
                    "{field} virtiofs tag must not be empty (e.g. use /path:tag)"
                )
            }
        }
    }
}

impl std::error::Error for ConfigError {}

/// True iff `s` is safe to pack into libkrun's kernel command line: every
/// byte is ASCII (0x00..=0x7F) and it contains no `\n`/`\r`. `str::is_ascii`
/// alone already excludes `\n`/`\r` (they're ASCII control characters, code
/// points 0x0A/0x0D), so the explicit newline check below is redundant with
/// it in practice — kept anyway as a documented, named check so a future
/// reader (or a future relaxation of the ASCII requirement, e.g. to allow
/// high-bit bytes some other way) doesn't accidentally lose the specific
/// newline guard the spike's `InvalidAscii` panic was actually about.
fn is_cmdline_safe(s: &str) -> bool {
    s.is_ascii() && !s.contains('\n') && !s.contains('\r')
}

/// Validates a single cmdline-bound string, returning the field-tagged error
/// on failure. `field` is a static label (e.g. `"exec_path"`,
/// `"exec_args[2]"`, `"env[GATEWAY_URL]"`) used only for error messages.
fn check_cmdline_safe(field: &'static str, value: &str) -> Result<(), ConfigError> {
    if is_cmdline_safe(value) {
        Ok(())
    } else {
        Err(ConfigError::NotCmdlineSafe {
            field,
            value: value.to_string(),
        })
    }
}

/// Raw, not-yet-validated inputs for [`LaunchConfig::validate`]. [`crate::cli`]
/// builds one of these straight from argv (no validation of its own) and
/// hands it here so there is exactly one place the actual rules live.
#[derive(Debug, Clone, Default)]
pub struct LaunchConfigInput {
    pub rootfs: PathBuf,
    pub vcpus: u8,
    pub ram_mib: u32,
    pub uid: u32,
    pub gid: u32,
    pub workdir: String,
    pub exec_path: String,
    pub exec_args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub vsock_port: Option<u32>,
    pub vsock_uds: Option<PathBuf>,
    pub work_mount_host_path: Option<PathBuf>,
    pub work_mount_tag: String,
    pub out_mount_host_path: Option<PathBuf>,
    pub out_mount_tag: String,
}

impl LaunchConfigInput {
    /// Runs every check in this module and, if all pass, produces a
    /// [`LaunchConfig`]. Fails on the FIRST violation found (field order
    /// below) rather than collecting every error — this is a CLI tool, not a
    /// form validator; one clear error to fix at a time is the right UX, and
    /// keeps the implementation (and its tests) simple.
    pub fn validate(self) -> Result<LaunchConfig, ConfigError> {
        if self.rootfs.as_os_str().is_empty() {
            return Err(ConfigError::RootfsEmpty);
        }
        must_be_absolute("--rootfs", &self.rootfs)?;
        if self.vcpus == 0 || self.vcpus > MAX_VCPUS {
            return Err(ConfigError::VcpusOutOfRange {
                requested: self.vcpus,
            });
        }
        if self.ram_mib <= MIN_RAM_MIB {
            return Err(ConfigError::RamTooLow {
                requested: self.ram_mib,
            });
        }
        if self.uid == 0 {
            return Err(ConfigError::RootIdRejected { field: "uid" });
        }
        if self.gid == 0 {
            return Err(ConfigError::RootIdRejected { field: "gid" });
        }
        check_cmdline_safe("workdir", &self.workdir)?;
        check_cmdline_safe("exec_path", &self.exec_path)?;
        for (i, arg) in self.exec_args.iter().enumerate() {
            check_cmdline_safe_owned(format!("exec_args[{i}]"), arg)?;
        }
        for (key, value) in &self.env {
            // Validate the composed "KEY=VALUE" form since that's the exact
            // string that ends up on the cmdline, not the two halves
            // separately — a key or value that's individually safe could
            // still combine into something unsafe only in combination (it
            // can't here since '=' is ASCII and neither half may contain
            // '\n', but composing first keeps this check honest against the
            // actual on-wire representation rather than an approximation of
            // it).
            let combined = format!("{key}={value}");
            check_cmdline_safe_owned(format!("env[{key}]"), &combined)?;
        }

        let vsock_gateway = match (self.vsock_port, self.vsock_uds) {
            (Some(port), Some(uds_path)) => {
                must_be_absolute("--vsock-uds", &uds_path)?;
                Some(VsockGateway { port, uds_path })
            }
            (None, None) => None,
            _ => return Err(ConfigError::VsockPortUdsUnpaired),
        };

        let work_mount = build_mount(
            "--work-mount",
            self.work_mount_host_path,
            self.work_mount_tag,
            true,
        )?;
        let out_mount = build_mount(
            "--out-mount",
            self.out_mount_host_path,
            self.out_mount_tag,
            false,
        )?;

        Ok(LaunchConfig {
            rootfs: self.rootfs,
            vcpus: self.vcpus,
            ram_mib: self.ram_mib,
            uid: self.uid,
            gid: self.gid,
            workdir: self.workdir,
            exec_path: self.exec_path,
            exec_args: self.exec_args,
            env: self.env,
            vsock_gateway,
            work_mount,
            out_mount,
        })
    }
}

/// Shared validation for `--work-mount`/`--out-mount`: both take an
/// identical `<host-path>[:<tag>]` grammar (parsed identically in
/// `cli.rs::split_work_mount`) and differ only in `field` (for error
/// messages) and `read_only` (the actual security-relevant property).
/// Factored out so the two flags can never silently drift apart in how
/// they're validated.
fn build_mount(
    field: &'static str,
    host_path: Option<PathBuf>,
    tag: String,
    read_only: bool,
) -> Result<Option<WorkMount>, ConfigError> {
    match host_path {
        Some(host_path) => {
            if host_path.as_os_str().is_empty() {
                return Err(ConfigError::WorkMountEmpty { field });
            }
            must_be_absolute(field, &host_path)?;
            if tag.is_empty() {
                return Err(ConfigError::WorkMountTagEmpty { field });
            }
            Ok(Some(WorkMount {
                host_path,
                tag,
                read_only,
            }))
        }
        None => Ok(None),
    }
}

/// Rejects a relative host path bound for libkrun. Shared by `--rootfs`, the
/// `--work-mount` host path, and `--vsock-uds` so all three enforce the same
/// absolute-path rule (see [`ConfigError::PathNotAbsolute`] for why). `field`
/// is a static label used only in the error message.
fn must_be_absolute(field: &'static str, path: &std::path::Path) -> Result<(), ConfigError> {
    if path.is_absolute() {
        Ok(())
    } else {
        Err(ConfigError::PathNotAbsolute {
            field,
            path: path.display().to_string(),
        })
    }
}

/// Helper for the two loop sites above, which need a `'static`-looking label
/// built at runtime (`format!("exec_args[{i}]")`) rather than a literal —
/// [`ConfigError::NotCmdlineSafe`]'s `field` is `&'static str` for the common
/// (literal) case, so this leaks the owned string to get a `'static`
/// reference. Leaking is fine here: this only runs at most a handful of
/// times per process invocation, on the error path of a short-lived CLI
/// tool, never in a loop that could accumulate unbounded leaks.
fn check_cmdline_safe_owned(field: String, value: &str) -> Result<(), ConfigError> {
    if is_cmdline_safe(value) {
        Ok(())
    } else {
        let leaked: &'static str = Box::leak(field.into_boxed_str());
        Err(ConfigError::NotCmdlineSafe {
            field: leaked,
            value: value.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_input() -> LaunchConfigInput {
        LaunchConfigInput {
            rootfs: PathBuf::from("/tmp/rootfs"),
            vcpus: 2,
            ram_mib: 1024,
            uid: 10001,
            gid: 10001,
            workdir: "/".to_string(),
            exec_path: "/bin/sh".to_string(),
            exec_args: vec!["-c".to_string(), "echo hi".to_string()],
            env: vec![("PATH".to_string(), "/usr/bin:/bin".to_string())],
            vsock_port: None,
            vsock_uds: None,
            work_mount_host_path: None,
            work_mount_tag: "work".to_string(),
            out_mount_host_path: None,
            out_mount_tag: "out".to_string(),
        }
    }

    #[test]
    fn valid_input_validates() {
        let cfg = valid_input()
            .validate()
            .expect("valid input should validate");
        assert_eq!(cfg.vcpus, 2);
        assert_eq!(cfg.ram_mib, 1024);
        assert_eq!(cfg.exec_path, "/bin/sh");
        assert!(cfg.vsock_gateway.is_none());
        assert!(cfg.work_mount.is_none());
        assert!(cfg.out_mount.is_none());
    }

    #[test]
    fn empty_rootfs_rejected() {
        let mut input = valid_input();
        input.rootfs = PathBuf::new();
        assert_eq!(input.validate().unwrap_err(), ConfigError::RootfsEmpty);
    }

    #[test]
    fn zero_vcpus_rejected() {
        let mut input = valid_input();
        input.vcpus = 0;
        assert_eq!(
            input.validate().unwrap_err(),
            ConfigError::VcpusOutOfRange { requested: 0 }
        );
    }

    #[test]
    fn too_many_vcpus_rejected() {
        let mut input = valid_input();
        input.vcpus = MAX_VCPUS + 1;
        assert_eq!(
            input.validate().unwrap_err(),
            ConfigError::VcpusOutOfRange {
                requested: MAX_VCPUS + 1
            }
        );
    }

    #[test]
    fn max_vcpus_accepted() {
        let mut input = valid_input();
        input.vcpus = MAX_VCPUS;
        assert!(input.validate().is_ok());
    }

    #[test]
    fn ram_at_floor_rejected() {
        let mut input = valid_input();
        input.ram_mib = MIN_RAM_MIB;
        assert_eq!(
            input.validate().unwrap_err(),
            ConfigError::RamTooLow {
                requested: MIN_RAM_MIB
            }
        );
    }

    #[test]
    fn ram_just_above_floor_accepted() {
        let mut input = valid_input();
        input.ram_mib = MIN_RAM_MIB + 1;
        assert!(input.validate().is_ok());
    }

    #[test]
    fn root_uid_rejected() {
        let mut input = valid_input();
        input.uid = 0;
        assert_eq!(
            input.validate().unwrap_err(),
            ConfigError::RootIdRejected { field: "uid" }
        );
    }

    #[test]
    fn root_gid_rejected() {
        let mut input = valid_input();
        input.gid = 0;
        assert_eq!(
            input.validate().unwrap_err(),
            ConfigError::RootIdRejected { field: "gid" }
        );
    }

    #[test]
    fn non_ascii_exec_path_rejected() {
        let mut input = valid_input();
        input.exec_path = "/bin/sh\u{e9}".to_string(); // trailing 'é'
        let err = input.validate().unwrap_err();
        match err {
            ConfigError::NotCmdlineSafe { field, .. } => assert_eq!(field, "exec_path"),
            other => panic!("expected NotCmdlineSafe, got {other:?}"),
        }
    }

    /// Reproduces the exact failure class the spike hit: a multi-line
    /// argument (e.g. an inline shell script) panicked libkrun host-side
    /// with `InvalidAscii` before the guest ever booted (see
    /// `spike/m8-a1/frontend-investigation.md`'s "Build note"). This must be
    /// caught here, cleanly, long before any FFI call.
    #[test]
    fn multiline_exec_arg_rejected() {
        let mut input = valid_input();
        input.exec_args = vec!["-c".to_string(), "echo hi\nrm -rf /".to_string()];
        let err = input.validate().unwrap_err();
        match err {
            ConfigError::NotCmdlineSafe { field, value } => {
                assert_eq!(field, "exec_args[1]");
                assert!(value.contains('\n'));
            }
            other => panic!("expected NotCmdlineSafe, got {other:?}"),
        }
    }

    #[test]
    fn carriage_return_rejected() {
        let mut input = valid_input();
        input.workdir = "/tmp\r".to_string();
        let err = input.validate().unwrap_err();
        assert!(matches!(
            err,
            ConfigError::NotCmdlineSafe {
                field: "workdir",
                ..
            }
        ));
    }

    #[test]
    fn unsafe_env_value_rejected() {
        let mut input = valid_input();
        input.env = vec![("EVIL".to_string(), "line1\nline2".to_string())];
        let err = input.validate().unwrap_err();
        match err {
            ConfigError::NotCmdlineSafe { field, .. } => assert_eq!(field, "env[EVIL]"),
            other => panic!("expected NotCmdlineSafe, got {other:?}"),
        }
    }

    #[test]
    fn vsock_port_without_uds_rejected() {
        let mut input = valid_input();
        input.vsock_port = Some(1234);
        assert_eq!(
            input.validate().unwrap_err(),
            ConfigError::VsockPortUdsUnpaired
        );
    }

    #[test]
    fn vsock_uds_without_port_rejected() {
        let mut input = valid_input();
        input.vsock_uds = Some(PathBuf::from("/tmp/gw.sock"));
        assert_eq!(
            input.validate().unwrap_err(),
            ConfigError::VsockPortUdsUnpaired
        );
    }

    #[test]
    fn vsock_relative_uds_rejected() {
        let mut input = valid_input();
        input.vsock_port = Some(1234);
        input.vsock_uds = Some(PathBuf::from("relative/gw.sock"));
        let err = input.validate().unwrap_err();
        assert!(matches!(
            err,
            ConfigError::PathNotAbsolute {
                field: "--vsock-uds",
                ..
            }
        ));
    }

    #[test]
    fn relative_rootfs_rejected() {
        let mut input = valid_input();
        input.rootfs = PathBuf::from("relative/rootfs");
        let err = input.validate().unwrap_err();
        assert!(matches!(
            err,
            ConfigError::PathNotAbsolute {
                field: "--rootfs",
                ..
            }
        ));
    }

    #[test]
    fn relative_work_mount_host_path_rejected() {
        let mut input = valid_input();
        input.work_mount_host_path = Some(PathBuf::from("relative/work"));
        let err = input.validate().unwrap_err();
        assert!(matches!(
            err,
            ConfigError::PathNotAbsolute {
                field: "--work-mount",
                ..
            }
        ));
    }

    #[test]
    fn empty_work_mount_tag_rejected() {
        let mut input = valid_input();
        input.work_mount_host_path = Some(PathBuf::from("/var/lib/magpie/work/job-1"));
        input.work_mount_tag = String::new();
        assert_eq!(
            input.validate().unwrap_err(),
            ConfigError::WorkMountTagEmpty {
                field: "--work-mount"
            }
        );
    }

    #[test]
    fn vsock_pair_accepted() {
        let mut input = valid_input();
        input.vsock_port = Some(1234);
        input.vsock_uds = Some(PathBuf::from("/tmp/gw.sock"));
        let cfg = input
            .validate()
            .expect("paired vsock config should validate");
        let gw = cfg.vsock_gateway.expect("vsock_gateway should be Some");
        assert_eq!(gw.port, 1234);
        assert_eq!(gw.uds_path, PathBuf::from("/tmp/gw.sock"));
    }

    #[test]
    fn neither_vsock_flag_is_fine() {
        let input = valid_input();
        assert!(input.validate().is_ok());
    }

    #[test]
    fn work_mount_empty_rejected() {
        let mut input = valid_input();
        input.work_mount_host_path = Some(PathBuf::new());
        assert_eq!(
            input.validate().unwrap_err(),
            ConfigError::WorkMountEmpty {
                field: "--work-mount"
            }
        );
    }

    #[test]
    fn work_mount_accepted() {
        let mut input = valid_input();
        input.work_mount_host_path = Some(PathBuf::from("/var/lib/magpie/work/job-1"));
        input.work_mount_tag = "work".to_string();
        let cfg = input.validate().expect("work mount should validate");
        let wm = cfg.work_mount.expect("work_mount should be Some");
        assert_eq!(wm.host_path, PathBuf::from("/var/lib/magpie/work/job-1"));
        assert_eq!(wm.tag, "work");
        assert!(wm.read_only, "--work-mount must be read-only");
        assert!(cfg.out_mount.is_none());
    }

    #[test]
    fn out_mount_accepted_and_writable() {
        let mut input = valid_input();
        input.out_mount_host_path = Some(PathBuf::from("/var/lib/magpie/work/job-1-out"));
        input.out_mount_tag = "out".to_string();
        let cfg = input.validate().expect("out mount should validate");
        let om = cfg.out_mount.expect("out_mount should be Some");
        assert_eq!(
            om.host_path,
            PathBuf::from("/var/lib/magpie/work/job-1-out")
        );
        assert_eq!(om.tag, "out");
        assert!(!om.read_only, "--out-mount must be writable");
        assert!(cfg.work_mount.is_none());
    }

    #[test]
    fn out_mount_empty_rejected() {
        let mut input = valid_input();
        input.out_mount_host_path = Some(PathBuf::new());
        assert_eq!(
            input.validate().unwrap_err(),
            ConfigError::WorkMountEmpty {
                field: "--out-mount"
            }
        );
    }

    #[test]
    fn out_mount_empty_tag_rejected() {
        let mut input = valid_input();
        input.out_mount_host_path = Some(PathBuf::from("/var/lib/magpie/work/job-1-out"));
        input.out_mount_tag = String::new();
        assert_eq!(
            input.validate().unwrap_err(),
            ConfigError::WorkMountTagEmpty {
                field: "--out-mount"
            }
        );
    }

    #[test]
    fn relative_out_mount_host_path_rejected() {
        let mut input = valid_input();
        input.out_mount_host_path = Some(PathBuf::from("relative/out"));
        let err = input.validate().unwrap_err();
        assert!(matches!(
            err,
            ConfigError::PathNotAbsolute {
                field: "--out-mount",
                ..
            }
        ));
    }

    #[test]
    fn work_mount_and_out_mount_both_accepted_independently() {
        let mut input = valid_input();
        input.work_mount_host_path = Some(PathBuf::from("/var/lib/magpie/work/job-1"));
        input.out_mount_host_path = Some(PathBuf::from("/var/lib/magpie/work/job-1-out"));
        let cfg = input.validate().expect("both mounts should validate");
        assert!(cfg.work_mount.unwrap().read_only);
        assert!(!cfg.out_mount.unwrap().read_only);
    }
}
