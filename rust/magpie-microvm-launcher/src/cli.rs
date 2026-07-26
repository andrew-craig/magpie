//! Hand-rolled CLI argument parsing — pure, no I/O, no libkrun linkage.
//! Exercised entirely by plain `cargo test`.
//!
//! # Contract
//!
//! ```text
//! magpie-krun-launch --rootfs <dir> --exec <path-in-guest>
//!     [--arg <a>]...            (repeatable; one guest argv entry each)
//!     [--vcpus <n>]             (default 2)
//!     [--ram-mib <n>]           (default 4096)
//!     --uid <n> --gid <n>       (required, non-root)
//!     [--workdir <path>]        (default "/")
//!     [--env KEY=VALUE]...      (repeatable)
//!     [--vsock-port <n> --vsock-uds <path>]   (both or neither)
//!     [--work-mount <host-path>[:<tag>]]      (tag defaults to "work")
//!     [--help]
//! ```
//!
//! Promoted from the spike's `MAGPIE_VSOCK_UDS`/`MAGPIE_VSOCK_PORT`
//! environment variables (`spike/m8-a1/magpie-krun-launch.c`) to explicit
//! flags: the spike kept the argv contract unchanged specifically so it
//! could bolt the gateway channel onto an existing experiment without
//! touching its call signature, but for the production launcher (this
//! crate) the vsock channel is a first-class, always-relevant input, not an
//! optional add-on — an explicit `--vsock-port`/`--vsock-uds` pair is more
//! discoverable (`--help` shows it), more testable (no process-env
//! plumbing in tests), and keeps every per-job input in one place (argv)
//! rather than split across argv and env.
//!
//! `--arg` (repeated) rather than a trailing `--` positional list: simpler
//! to parse unambiguously by hand (no "is this a flag or a positional"
//! lookahead), and reads clearly at the call site
//! (`--exec /bin/sh --arg -c --arg 'echo hi'` — note the second `--arg`'s
//! value itself starts with `-c`-like content and still parses correctly,
//! since `--arg` unconditionally consumes exactly the next token as its
//! value with no flag-sniffing).

use std::path::PathBuf;

use crate::config::LaunchConfigInput;

/// Default vCPU count when `--vcpus` is omitted. Matches the reviewer's
/// current docker-based `config.container.cpus` example default (see
/// `config.example.toml`) — not load-bearing, just a sane fallback for
/// manual/ad-hoc invocations; a real per-job caller (task_39ff) should
/// always pass this explicitly.
const DEFAULT_VCPUS: u8 = 2;

/// Default guest RAM in MiB when `--ram-mib` is omitted. `4g` in docker-config
/// terms, mirroring `config.example.toml`'s `[container] memory = "4g"`.
const DEFAULT_RAM_MIB: u32 = 4096;

/// Default guest-relative working directory when `--workdir` is omitted.
const DEFAULT_WORKDIR: &str = "/";

/// Default virtiofs tag for `--work-mount` when no `:<tag>` suffix is given.
const DEFAULT_WORK_MOUNT_TAG: &str = "work";

/// Everything that can go wrong parsing argv, before validation
/// ([`crate::config::ConfigError`]) even runs. Kept separate from
/// `ConfigError` because these are argv-SHAPE problems (missing value,
/// unknown flag, bad integer) rather than argv-VALUE problems (a syntactically
/// fine value that's semantically unsafe/out of range) — different failure
/// classes a caller might reasonably want to distinguish (e.g. a shape error
/// is a usage bug, a validation error might be a legitimate per-job input
/// that's simply out of policy).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliError {
    /// `--help` was requested. Not really an "error" — `main.rs` treats this
    /// as "print usage and exit 0" rather than "print usage and exit 2" like
    /// every other variant here — but modeled as one so `parse` has a single
    /// `Result` return type instead of a three-way enum.
    HelpRequested,
    UnknownFlag(String),
    MissingValue(&'static str),
    MissingRequired(&'static str),
    InvalidInteger {
        flag: &'static str,
        value: String,
    },
    InvalidEnvPair(String),
    /// `--work-mount` had more than one `:` (ambiguous: which colon
    /// separates path from tag?). Windows-style drive-letter paths aren't a
    /// concern here — this launcher only ever runs on Linux (`krun_setuid`,
    /// `AF_VSOCK`, `/dev/kvm` are all Linux-only), so a bare `:` is always
    /// the path/tag separator, never part of the path itself.
    AmbiguousWorkMount(String),
}

impl std::fmt::Display for CliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CliError::HelpRequested => write!(f, "help requested"),
            CliError::UnknownFlag(flag) => write!(f, "unknown flag: {flag}"),
            CliError::MissingValue(flag) => write!(f, "{flag} requires a value"),
            CliError::MissingRequired(flag) => write!(f, "{flag} is required"),
            CliError::InvalidInteger { flag, value } => {
                write!(f, "{flag}: invalid integer {value:?}")
            }
            CliError::InvalidEnvPair(raw) => {
                write!(f, "--env value must be KEY=VALUE, got {raw:?}")
            }
            CliError::AmbiguousWorkMount(raw) => {
                write!(
                    f,
                    "--work-mount must be <host-path>[:<tag>] (at most one ':'), got {raw:?}"
                )
            }
        }
    }
}

impl std::error::Error for CliError {}

/// The full `--help` text, printed verbatim by `main.rs` on `--help` or a
/// usage error (so a mistyped invocation always shows the contract, not just
/// a terse "unknown flag").
pub const USAGE: &str = "\
magpie-krun-launch — host-side micro-VM launcher (M8-C0 / task_76d6)

Boots an unpacked OCI rootfs as a rootless libkrun micro-VM: TSI-off
no-network, VMM-enforced vcpu/RAM, an optional per-VM vsock gateway channel,
and an optional read-only /work virtiofs mount.

USAGE:
    magpie-krun-launch --rootfs <dir> --exec <path> [OPTIONS]

REQUIRED:
    --rootfs <dir>          Host directory to use as the guest root filesystem
                             (an unpacked OCI image, e.g. via `podman export`)
    --exec <path>            Path to the executable inside the guest rootfs
    --uid <n>                 Non-root uid for krun_setuid (host-side VMM process)
    --gid <n>                 Non-root gid for krun_setgid (host-side VMM process)

OPTIONS:
    --arg <value>              One guest argv entry (repeatable, in order)
    --vcpus <n>                 vCPU count, 1..=16 (default 2)
    --ram-mib <n>                Guest RAM in MiB, >128 (default 4096)
    --workdir <path>              Guest-relative working directory (default \"/\")
    --env <KEY=VALUE>              One guest env var (repeatable)
    --vsock-port <n>                 vsock port the guest dials (needs --vsock-uds)
    --vsock-uds <path>                 Host unix socket path (needs --vsock-port; must be absolute)
    --work-mount <host-path>[:<tag>]     Read-only virtiofs device (tag default \"work\")
    --help                                  Print this message and exit 0
";

/// Parses `args` (NOT including argv[0] — callers pass `env::args().skip(1)`)
/// into a [`LaunchConfigInput`]. Performs no validation beyond argv SHAPE
/// (see [`CliError`]'s doc comment); call `.validate()` on the result to get
/// a [`crate::config::LaunchConfig`].
pub fn parse<I: IntoIterator<Item = String>>(args: I) -> Result<LaunchConfigInput, CliError> {
    let mut rootfs: Option<PathBuf> = None;
    let mut exec_path: Option<String> = None;
    let mut exec_args: Vec<String> = Vec::new();
    let mut vcpus: u8 = DEFAULT_VCPUS;
    let mut ram_mib: u32 = DEFAULT_RAM_MIB;
    let mut uid: Option<u32> = None;
    let mut gid: Option<u32> = None;
    let mut workdir: String = DEFAULT_WORKDIR.to_string();
    let mut env: Vec<(String, String)> = Vec::new();
    let mut vsock_port: Option<u32> = None;
    let mut vsock_uds: Option<PathBuf> = None;
    let mut work_mount_host_path: Option<PathBuf> = None;
    let mut work_mount_tag: String = DEFAULT_WORK_MOUNT_TAG.to_string();

    let mut iter = args.into_iter();
    while let Some(flag) = iter.next() {
        match flag.as_str() {
            "--help" | "-h" => return Err(CliError::HelpRequested),
            "--rootfs" => rootfs = Some(PathBuf::from(next_value(&mut iter, "--rootfs")?)),
            "--exec" => exec_path = Some(next_value(&mut iter, "--exec")?),
            "--arg" => exec_args.push(next_value(&mut iter, "--arg")?),
            "--vcpus" => vcpus = parse_u8(&mut iter, "--vcpus")?,
            "--ram-mib" => ram_mib = parse_u32(&mut iter, "--ram-mib")?,
            "--uid" => uid = Some(parse_u32(&mut iter, "--uid")?),
            "--gid" => gid = Some(parse_u32(&mut iter, "--gid")?),
            "--workdir" => workdir = next_value(&mut iter, "--workdir")?,
            "--env" => {
                let raw = next_value(&mut iter, "--env")?;
                env.push(split_env_pair(&raw)?);
            }
            "--vsock-port" => vsock_port = Some(parse_u32(&mut iter, "--vsock-port")?),
            "--vsock-uds" => vsock_uds = Some(PathBuf::from(next_value(&mut iter, "--vsock-uds")?)),
            "--work-mount" => {
                let raw = next_value(&mut iter, "--work-mount")?;
                let (host_path, tag) = split_work_mount(&raw)?;
                work_mount_host_path = Some(host_path);
                if let Some(tag) = tag {
                    work_mount_tag = tag;
                }
            }
            other => return Err(CliError::UnknownFlag(other.to_string())),
        }
    }

    Ok(LaunchConfigInput {
        rootfs: rootfs.ok_or(CliError::MissingRequired("--rootfs"))?,
        vcpus,
        ram_mib,
        uid: uid.ok_or(CliError::MissingRequired("--uid"))?,
        gid: gid.ok_or(CliError::MissingRequired("--gid"))?,
        workdir,
        exec_path: exec_path.ok_or(CliError::MissingRequired("--exec"))?,
        exec_args,
        env,
        vsock_port,
        vsock_uds,
        work_mount_host_path,
        work_mount_tag,
    })
}

fn next_value<I: Iterator<Item = String>>(
    iter: &mut I,
    flag: &'static str,
) -> Result<String, CliError> {
    iter.next().ok_or(CliError::MissingValue(flag))
}

fn parse_u8<I: Iterator<Item = String>>(iter: &mut I, flag: &'static str) -> Result<u8, CliError> {
    let raw = next_value(iter, flag)?;
    raw.parse::<u8>()
        .map_err(|_| CliError::InvalidInteger { flag, value: raw })
}

fn parse_u32<I: Iterator<Item = String>>(
    iter: &mut I,
    flag: &'static str,
) -> Result<u32, CliError> {
    let raw = next_value(iter, flag)?;
    raw.parse::<u32>()
        .map_err(|_| CliError::InvalidInteger { flag, value: raw })
}

/// Splits a `--env` value on the FIRST `=` (so a value that itself contains
/// `=`, e.g. a base64 blob, still round-trips correctly — only the key is
/// assumed `=`-free).
fn split_env_pair(raw: &str) -> Result<(String, String), CliError> {
    match raw.split_once('=') {
        Some((key, value)) if !key.is_empty() => Ok((key.to_string(), value.to_string())),
        _ => Err(CliError::InvalidEnvPair(raw.to_string())),
    }
}

/// Splits a `--work-mount` value into `(host_path, Option<tag>)`. At most one
/// `:` is allowed (see [`CliError::AmbiguousWorkMount`]'s doc comment for
/// why a bare `:` is unambiguous on the Linux-only platform this runs on).
fn split_work_mount(raw: &str) -> Result<(PathBuf, Option<String>), CliError> {
    let parts: Vec<&str> = raw.splitn(3, ':').collect();
    match parts.as_slice() {
        [path] => Ok((PathBuf::from(*path), None)),
        [path, tag] => Ok((PathBuf::from(*path), Some((*tag).to_string()))),
        _ => Err(CliError::AmbiguousWorkMount(raw.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &[&str]) -> Vec<String> {
        s.iter().map(|s| s.to_string()).collect()
    }

    fn minimal_required() -> Vec<String> {
        args(&[
            "--rootfs",
            "/tmp/rootfs",
            "--exec",
            "/bin/sh",
            "--uid",
            "10001",
            "--gid",
            "10001",
        ])
    }

    #[test]
    fn minimal_required_parses_with_defaults() {
        let parsed = parse(minimal_required()).expect("minimal required flags should parse");
        assert_eq!(parsed.rootfs, PathBuf::from("/tmp/rootfs"));
        assert_eq!(parsed.exec_path, "/bin/sh");
        assert_eq!(parsed.uid, 10001);
        assert_eq!(parsed.gid, 10001);
        assert_eq!(parsed.vcpus, DEFAULT_VCPUS);
        assert_eq!(parsed.ram_mib, DEFAULT_RAM_MIB);
        assert_eq!(parsed.workdir, DEFAULT_WORKDIR);
        assert!(parsed.exec_args.is_empty());
        assert!(parsed.env.is_empty());
        assert!(parsed.vsock_port.is_none());
        assert!(parsed.vsock_uds.is_none());
        assert!(parsed.work_mount_host_path.is_none());
    }

    #[test]
    fn missing_rootfs_rejected() {
        let a = args(&["--exec", "/bin/sh", "--uid", "10001", "--gid", "10001"]);
        assert_eq!(parse(a).unwrap_err(), CliError::MissingRequired("--rootfs"));
    }

    #[test]
    fn missing_exec_rejected() {
        let a = args(&[
            "--rootfs",
            "/tmp/rootfs",
            "--uid",
            "10001",
            "--gid",
            "10001",
        ]);
        assert_eq!(parse(a).unwrap_err(), CliError::MissingRequired("--exec"));
    }

    #[test]
    fn missing_uid_rejected() {
        let a = args(&[
            "--rootfs",
            "/tmp/rootfs",
            "--exec",
            "/bin/sh",
            "--gid",
            "10001",
        ]);
        assert_eq!(parse(a).unwrap_err(), CliError::MissingRequired("--uid"));
    }

    #[test]
    fn missing_gid_rejected() {
        let a = args(&[
            "--rootfs",
            "/tmp/rootfs",
            "--exec",
            "/bin/sh",
            "--uid",
            "10001",
        ]);
        assert_eq!(parse(a).unwrap_err(), CliError::MissingRequired("--gid"));
    }

    #[test]
    fn dangling_flag_missing_value() {
        let a = args(&["--rootfs"]);
        assert_eq!(parse(a).unwrap_err(), CliError::MissingValue("--rootfs"));
    }

    #[test]
    fn unknown_flag_rejected() {
        let mut a = minimal_required();
        a.push("--bogus".to_string());
        assert_eq!(
            parse(a).unwrap_err(),
            CliError::UnknownFlag("--bogus".to_string())
        );
    }

    #[test]
    fn help_short_circuits() {
        let a = args(&["--help"]);
        assert_eq!(parse(a).unwrap_err(), CliError::HelpRequested);
    }

    #[test]
    fn help_short_circuits_even_mid_argv() {
        let mut a = minimal_required();
        a.push("--help".to_string());
        assert_eq!(parse(a).unwrap_err(), CliError::HelpRequested);
    }

    #[test]
    fn repeated_arg_preserves_order() {
        let mut a = minimal_required();
        a.extend(args(&["--arg", "-c", "--arg", "echo hi"]));
        let parsed = parse(a).unwrap();
        assert_eq!(
            parsed.exec_args,
            vec!["-c".to_string(), "echo hi".to_string()]
        );
    }

    #[test]
    fn arg_value_that_looks_like_a_flag_is_not_sniffed() {
        // "--arg"'s value is taken unconditionally as the next token, even
        // if that token itself starts with "--" — this must not be
        // misinterpreted as a new flag.
        let mut a = minimal_required();
        a.extend(args(&["--arg", "--looks-like-a-flag"]));
        let parsed = parse(a).unwrap();
        assert_eq!(parsed.exec_args, vec!["--looks-like-a-flag".to_string()]);
    }

    #[test]
    fn invalid_vcpus_integer_rejected() {
        let mut a = minimal_required();
        a.extend(args(&["--vcpus", "not-a-number"]));
        assert_eq!(
            parse(a).unwrap_err(),
            CliError::InvalidInteger {
                flag: "--vcpus",
                value: "not-a-number".to_string()
            }
        );
    }

    #[test]
    fn vcpus_overflowing_u8_rejected_as_invalid_integer() {
        let mut a = minimal_required();
        a.extend(args(&["--vcpus", "300"])); // > u8::MAX
        assert!(matches!(
            parse(a).unwrap_err(),
            CliError::InvalidInteger {
                flag: "--vcpus",
                ..
            }
        ));
    }

    #[test]
    fn env_pair_parses() {
        let mut a = minimal_required();
        a.extend(args(&["--env", "PATH=/usr/bin:/bin"]));
        let parsed = parse(a).unwrap();
        assert_eq!(
            parsed.env,
            vec![("PATH".to_string(), "/usr/bin:/bin".to_string())]
        );
    }

    #[test]
    fn env_pair_with_no_equals_rejected() {
        let mut a = minimal_required();
        a.extend(args(&["--env", "NOEQUALS"]));
        assert_eq!(
            parse(a).unwrap_err(),
            CliError::InvalidEnvPair("NOEQUALS".to_string())
        );
    }

    #[test]
    fn env_pair_with_empty_key_rejected() {
        let mut a = minimal_required();
        a.extend(args(&["--env", "=value"]));
        assert_eq!(
            parse(a).unwrap_err(),
            CliError::InvalidEnvPair("=value".to_string())
        );
    }

    #[test]
    fn env_value_containing_equals_round_trips() {
        let mut a = minimal_required();
        a.extend(args(&["--env", "TOKEN=a=b=c"]));
        let parsed = parse(a).unwrap();
        assert_eq!(parsed.env, vec![("TOKEN".to_string(), "a=b=c".to_string())]);
    }

    #[test]
    fn vsock_pair_parses() {
        let mut a = minimal_required();
        a.extend(args(&[
            "--vsock-port",
            "1234",
            "--vsock-uds",
            "/tmp/gw.sock",
        ]));
        let parsed = parse(a).unwrap();
        assert_eq!(parsed.vsock_port, Some(1234));
        assert_eq!(parsed.vsock_uds, Some(PathBuf::from("/tmp/gw.sock")));
    }

    #[test]
    fn work_mount_without_tag_uses_default() {
        let mut a = minimal_required();
        a.extend(args(&["--work-mount", "/var/lib/magpie/work/job-1"]));
        let parsed = parse(a).unwrap();
        assert_eq!(
            parsed.work_mount_host_path,
            Some(PathBuf::from("/var/lib/magpie/work/job-1"))
        );
        assert_eq!(parsed.work_mount_tag, DEFAULT_WORK_MOUNT_TAG);
    }

    #[test]
    fn work_mount_with_explicit_tag() {
        let mut a = minimal_required();
        a.extend(args(&[
            "--work-mount",
            "/var/lib/magpie/work/job-1:pr-workspace",
        ]));
        let parsed = parse(a).unwrap();
        assert_eq!(
            parsed.work_mount_host_path,
            Some(PathBuf::from("/var/lib/magpie/work/job-1"))
        );
        assert_eq!(parsed.work_mount_tag, "pr-workspace");
    }

    #[test]
    fn work_mount_with_two_colons_rejected() {
        let mut a = minimal_required();
        a.extend(args(&["--work-mount", "/a:b:c"]));
        assert!(matches!(
            parse(a).unwrap_err(),
            CliError::AmbiguousWorkMount(_)
        ));
    }

    #[test]
    fn full_invocation_parses_end_to_end_and_validates() {
        let a = args(&[
            "--rootfs",
            "/tmp/rootfs",
            "--exec",
            "/bin/sh",
            "--arg",
            "-c",
            "--arg",
            "echo hi",
            "--vcpus",
            "4",
            "--ram-mib",
            "2048",
            "--uid",
            "10001",
            "--gid",
            "10001",
            "--workdir",
            "/work",
            "--env",
            "PATH=/usr/bin",
            "--vsock-port",
            "1234",
            "--vsock-uds",
            "/tmp/gw.sock",
            "--work-mount",
            "/var/lib/magpie/work/job-1:work",
        ]);
        let input = parse(a).expect("full invocation should parse");
        let cfg = input.validate().expect("full invocation should validate");
        assert_eq!(cfg.vcpus, 4);
        assert_eq!(cfg.ram_mib, 2048);
        assert_eq!(cfg.workdir, "/work");
        assert_eq!(cfg.exec_args, vec!["-c".to_string(), "echo hi".to_string()]);
        assert_eq!(cfg.vsock_gateway.unwrap().port, 1234);
        assert_eq!(cfg.work_mount.unwrap().tag, "work");
    }
}
