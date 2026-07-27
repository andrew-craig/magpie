//! Raw `extern "C"` bindings for the slice of libkrun's C ABI this launcher
//! needs, plus [`boot`], the safe wrapper that drives them in the exact
//! order proven by the spike (`spike/m8-a1/magpie-krun-launch.c`).
//!
//! # ABI pin
//!
//! [`LIBKRUN_ABI_PIN`] records the exact libkrun version/ABI this crate was
//! written and tested against. libkrun HEAD builds ABI 2
//! (`spike/m8-a1/provision.sh` correction (b)); this crate targets ABI 1
//! (v1.19.4), matching the host-installed
//! `/usr/local/lib64/libkrun.so.1.19.4`. If the host's libkrun is ever
//! bumped to ABI 2, treat that as a breaking change requiring a fresh
//! verification pass over every call below (signatures, ordering
//! constraints, and the `krun_setuid` finding documented on [`boot`]), not a
//! silent recompile.
//!
//! # `krun_setuid`/`krun_setgid` do NOT confine the guest — READ BEFORE RELYING ON THEM
//!
//! This is the single most important thing to understand about this module,
//! and it was confirmed two ways before writing a line of this file:
//!
//! 1. **Source-level.** `spike/m8-a1/libkrun/src/libkrun/src/lib.rs:2299-2318`
//!    (`krun_setuid`/`krun_setgid`'s actual implementation) stores the
//!    requested id as `vmm_uid`/`vmm_gid` on the config struct, and
//!    `lib.rs:2993-3003` applies it via a plain `libc::setuid()`/`setgid()`
//!    call on the HOST process — the hypervisor/VMM itself — immediately
//!    before it starts the VM. Nothing in that path touches the guest's own
//!    process identity; the guest is a completely separate kernel + init
//!    that libkrun boots fresh (see `spike/m8-a1/libkrun/src/init_blob/init/init.c`),
//!    and that init has NO uid/gid-related code at all (confirmed by
//!    exhaustive grep in `spike/m8-a1/flag-investigation.md` §3 — the guest
//!    init's config parser only ever reads `Env`/`Cmd`/`WorkingDir`/`Entrypoint`
//!    keys).
//! 2. **Empirically, through THIS launcher's own direct calls** (not through
//!    crun, which never calls `krun_setuid` at all — this launcher does, and
//!    still gets the same result). See this crate's task-review smoke-test
//!    output: with `krun_setuid(ctx, 10001)`/`krun_setgid(ctx, 10001)` called
//!    and the guest's own `exec_path` running `id`, the guest reports
//!    `uid=0(root) gid=0(root)` — proving the direct-libkrun call sequence
//!    (not just crun's shim) leaves the guest as root.
//!
//! **Conclusion: this launcher still calls `krun_setuid`/`krun_setgid`
//! (defence-in-depth on the HOST-side VMM process — the same protection
//! `--user` already provided under the docker/crun path, see
//! `spike/m8-a1/flag-investigation.md` §3(a)), but the guest itself is
//! ALWAYS root today.** Confining the guest process requires an
//! image-side mitigation this launcher cannot provide by itself: the
//! reviewer image's own entrypoint (which the guest execs as root) must
//! `su-exec`/`setpriv` itself down to an unprivileged uid BEFORE running Pi.
//! That's a `docker/reviewer/entrypoint.sh` change, out of this standalone
//! launcher's scope (task_76d6) — tracked as a prerequisite for whichever
//! task wires this launcher into the orchestrator (`task_39ff`).
//!
//! # Call ordering
//!
//! `krun_add_vsock` REQUIRES a prior `krun_disable_implicit_vsock` call in
//! this ABI (`libkrun.h:939` — "By default, libkrun creates a vsock device
//! implicitly... To use this function, you must first call
//! krun_disable_implicit_vsock()"), else it errors because the implicit
//! device is already attached. [`boot`] always calls them back-to-back in
//! that order, whether or not a gateway channel is configured — TSI-off is
//! unconditional, not something a caller can accidentally skip by never
//! setting `--vsock-port`.

#![allow(non_camel_case_types)]

use std::convert::Infallible;
use std::ffi::CString;
use std::os::raw::c_char;
use std::path::Path;

use libc::{gid_t, uid_t};

use crate::config::LaunchConfig;

/// See the module doc comment's "ABI pin" section.
pub const LIBKRUN_ABI_PIN: &str = "v1.19.4 (ABI 1)";

/// TSI feature bitmask meaning "no hijacking at all" (see `libkrun.h`'s
/// `KRUN_TSI_HIJACK_INET`/`KRUN_TSI_HIJACK_UNIX` — both bits clear).
const TSI_NO_HIJACK: u32 = 0;

#[link(name = "krun")]
extern "C" {
    fn krun_create_ctx() -> i32;
    fn krun_set_vm_config(ctx_id: u32, num_vcpus: u8, ram_mib: u32) -> i32;
    fn krun_set_root(ctx_id: u32, root_path: *const c_char) -> i32;
    fn krun_add_virtiofs3(
        ctx_id: u32,
        c_tag: *const c_char,
        c_path: *const c_char,
        shm_size: u64,
        read_only: bool,
    ) -> i32;
    fn krun_disable_implicit_vsock(ctx_id: u32) -> i32;
    fn krun_add_vsock(ctx_id: u32, tsi_features: u32) -> i32;
    fn krun_add_vsock_port2(ctx_id: u32, port: u32, c_filepath: *const c_char, listen: bool)
        -> i32;
    fn krun_setuid(ctx_id: u32, uid: uid_t) -> i32;
    fn krun_setgid(ctx_id: u32, gid: gid_t) -> i32;
    fn krun_set_workdir(ctx_id: u32, workdir_path: *const c_char) -> i32;
    fn krun_set_exec(
        ctx_id: u32,
        exec_path: *const c_char,
        argv: *const *const c_char,
        envp: *const *const c_char,
    ) -> i32;
    fn krun_start_enter(ctx_id: u32) -> i32;
}

/// Every way [`boot`] can fail. Only ever constructed on the "libkrun
/// detected a problem before starting the VM" path — see [`boot`]'s doc
/// comment for why a *successful* boot never actually returns to the caller.
#[derive(Debug)]
pub enum BootError {
    /// A libkrun call returned a negative error code. `call` names the
    /// failing function; `code` is the raw return value (a negative
    /// `-errno`, per every `libkrun.h` function's "negative error number on
    /// failure" contract).
    Krun { call: &'static str, code: i32 },
    /// A `LaunchConfig` string field contained an interior NUL byte, so it
    /// can't be represented as a C string at all. [`crate::config`]'s
    /// cmdline-ASCII validation already rejects control characters
    /// including NUL for anything bound for the kernel cmdline, so this is
    /// a defence-in-depth path that should be unreachable in practice
    /// (kept as a clean error rather than an `.expect()` panic, since a
    /// panic here would be a confusing way to fail a privileged process).
    NulByte { field: &'static str },
    /// Raising `RLIMIT_NOFILE` before `krun_create_ctx` failed. Mirrors
    /// `spike/m8-a1/magpie-krun-launch.c`'s `getrlimit`/`setrlimit` calls —
    /// libkrun's VMM can open many file descriptors (one per virtio queue /
    /// device), and the spike raised the limit defensively before creating
    /// the context.
    RaiseRlimit(std::io::Error),
}

impl std::fmt::Display for BootError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BootError::Krun { call, code } => write!(
                f,
                "{call} failed: {code} ({})",
                std::io::Error::from_raw_os_error(-code)
            ),
            BootError::NulByte { field } => write!(
                f,
                "{field} contains an interior NUL byte and cannot be passed to libkrun"
            ),
            BootError::RaiseRlimit(err) => write!(
                f,
                "failed to raise RLIMIT_NOFILE before krun_create_ctx: {err}"
            ),
        }
    }
}

impl std::error::Error for BootError {}

fn cstring(field: &'static str, s: &str) -> Result<CString, BootError> {
    CString::new(s).map_err(|_| BootError::NulByte { field })
}

fn cstring_path(field: &'static str, p: &Path) -> Result<CString, BootError> {
    // `LaunchConfig` paths originate from CLI argv (already UTF-8 by
    // construction — `String`/argv on this platform) or from
    // `PathBuf::from` of one, so non-UTF-8 is not a realistic input here;
    // still handled as a clean NulByte-shaped error (reusing that variant
    // rather than adding a one-off "non-UTF-8 path" variant for a case that
    // can't currently occur) rather than panicking.
    let s = p.to_str().ok_or(BootError::NulByte { field })?;
    cstring(field, s)
}

/// Checks a libkrun return code (negative == error) and names the call in
/// any resulting [`BootError`], so a failure deep in the sequence still
/// says exactly which of the ~11 calls failed rather than just "boot
/// failed".
fn check(call: &'static str, code: i32) -> Result<(), BootError> {
    if code < 0 {
        Err(BootError::Krun { call, code })
    } else {
        Ok(())
    }
}

/// Builds a null-terminated array of raw pointers into `cstrings`, suitable
/// for `krun_set_exec`'s `argv`/`envp` parameters. Pure pointer-shape logic,
/// factored out so it's unit-testable independent of any actual FFI call —
/// see the tests below for the "null-terminated, right length, points at
/// the right bytes" assertions.
///
/// SAFETY (for callers): the returned `Vec<*const c_char>` borrows from
/// `cstrings` and must not outlive it.
fn null_terminated_ptrs(cstrings: &[CString]) -> Vec<*const c_char> {
    let mut ptrs: Vec<*const c_char> = cstrings.iter().map(|c| c.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    ptrs
}

/// Raises this process's `RLIMIT_NOFILE` soft limit to its hard limit,
/// mirroring `spike/m8-a1/magpie-krun-launch.c`'s `getrlimit`/`setrlimit`
/// dance before `krun_create_ctx`.
fn raise_nofile_rlimit() -> Result<(), BootError> {
    // SAFETY: `rlim` is a plain repr(C) struct with no pointers/invariants
    // beyond "two integers" — zero-initializing it and immediately
    // overwriting both fields via `getrlimit` is sound. Both libc calls are
    // simple syscalls with out-parameters this code owns exclusively.
    unsafe {
        let mut rlim: libc::rlimit = std::mem::zeroed();
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut rlim) != 0 {
            return Err(BootError::RaiseRlimit(std::io::Error::last_os_error()));
        }
        rlim.rlim_cur = rlim.rlim_max;
        if libc::setrlimit(libc::RLIMIT_NOFILE, &rlim) != 0 {
            return Err(BootError::RaiseRlimit(std::io::Error::last_os_error()));
        }
    }
    Ok(())
}

/// Boots `config` as a rootless micro-VM, making the exact same libkrun
/// calls in the exact same order as `spike/m8-a1/magpie-krun-launch.c`
/// (extended with the virtiofs `/work` mount, the vsock gateway port, and
/// setuid/setgid, all proven individually in the spike's addenda).
///
/// # This function does not return on success
///
/// Per `krun_start_enter`'s own doc comment in `libkrun.h`: "This function
/// only returns if an error happens before starting the microVM. Otherwise,
/// the VMM assumes it has full control of the process, and will call to
/// exit() with the workload's exit code once the microVM shuts down." So a
/// successful boot ends this process via libkrun's own `exit()` call, never
/// by returning `Ok` here — the `Result<Infallible, BootError>` signature
/// makes that contract explicit in the type system rather than a doc-only
/// claim: there is no `Ok` value this function can actually construct.
///
/// # Errors
///
/// Returns `Err` the moment any call in the sequence returns a negative
/// libkrun error code, WITHOUT attempting later calls (fail-closed: e.g. if
/// `krun_disable_implicit_vsock`/`krun_add_vsock` fails, this function does
/// not go on to call `krun_setuid`/`krun_set_exec`/`krun_start_enter` — a VM
/// must never start with an ambiguous TSI state).
pub fn boot(config: &LaunchConfig) -> Result<Infallible, BootError> {
    raise_nofile_rlimit()?;

    // SAFETY: every call below passes either a plain integer or a pointer
    // to a NUL-terminated buffer this function owns for the duration of the
    // call (the `CString`s are all still in scope; `argv`/`envp` arrays
    // borrow from `CString`s that outlive the `krun_set_exec` call). `ctx_id`
    // is the value libkrun itself returned from `krun_create_ctx` and is
    // used exactly as its own header documents (an opaque handle, never
    // dereferenced by this code).
    unsafe {
        let ctx_raw = krun_create_ctx();
        if ctx_raw < 0 {
            return Err(BootError::Krun {
                call: "krun_create_ctx",
                code: ctx_raw,
            });
        }
        let ctx_id = ctx_raw as u32;

        check(
            "krun_set_vm_config",
            krun_set_vm_config(ctx_id, config.vcpus, config.ram_mib),
        )?;

        let root_c = cstring_path("rootfs", &config.rootfs)?;
        check("krun_set_root", krun_set_root(ctx_id, root_c.as_ptr()))?;

        // Read-only /work virtiofs device (see LaunchConfig::work_mount's
        // doc comment: attaching the device is this launcher's job; mounting
        // it inside the guest is the exec target's).
        if let Some(work_mount) = &config.work_mount {
            let tag_c = cstring("work_mount.tag", &work_mount.tag)?;
            let path_c = cstring_path("work_mount.host_path", &work_mount.host_path)?;
            check(
                "krun_add_virtiofs3",
                krun_add_virtiofs3(
                    ctx_id,
                    tag_c.as_ptr(),
                    path_c.as_ptr(),
                    0,
                    work_mount.read_only,
                ),
            )?;
        }

        // Writable /out virtiofs device (task_39ff / M8-C3) — how the guest
        // hands `findings.json` back to the host, mirroring docker's
        // `-v <outDir>:/out` (read-write) bind mount. Same call as the
        // `/work` device above, differing only in `read_only` (always
        // `false` here per `LaunchConfig::out_mount`'s doc comment — this
        // launcher never constructs an `out_mount` with `read_only: true`,
        // but the check still reads the field rather than hardcoding
        // `false` so a future caller mistake would change behavior loudly,
        // not silently).
        if let Some(out_mount) = &config.out_mount {
            let tag_c = cstring("out_mount.tag", &out_mount.tag)?;
            let path_c = cstring_path("out_mount.host_path", &out_mount.host_path)?;
            check(
                "krun_add_virtiofs3",
                krun_add_virtiofs3(
                    ctx_id,
                    tag_c.as_ptr(),
                    path_c.as_ptr(),
                    0,
                    out_mount.read_only,
                ),
            )?;
        }

        // TSI OFF — unconditional (see module doc comment "Call ordering").
        check(
            "krun_disable_implicit_vsock",
            krun_disable_implicit_vsock(ctx_id),
        )?;
        check("krun_add_vsock", krun_add_vsock(ctx_id, TSI_NO_HIJACK))?;

        // Per-VM HYBRID gateway channel, if configured. `listen: false` —
        // the GUEST initiates the connection by dialing the vsock port;
        // libkrun bridges that to the host unix socket at `uds_path`
        // (confirmed against `spike/m8-a1/libkrun/src/vmm/src/.../muxer.rs:578`
        // in the spike's addendum, and against this crate's own smoke test).
        if let Some(gw) = &config.vsock_gateway {
            let uds_c = cstring_path("vsock_gateway.uds_path", &gw.uds_path)?;
            check(
                "krun_add_vsock_port2",
                krun_add_vsock_port2(ctx_id, gw.port, uds_c.as_ptr(), false),
            )?;
        }

        // Non-root HOST-side VMM process. See module doc comment: this does
        // NOT confine the guest, which remains root regardless.
        check("krun_setuid", krun_setuid(ctx_id, config.uid))?;
        check("krun_setgid", krun_setgid(ctx_id, config.gid))?;

        let workdir_c = cstring("workdir", &config.workdir)?;
        check(
            "krun_set_workdir",
            krun_set_workdir(ctx_id, workdir_c.as_ptr()),
        )?;

        let exec_c = cstring("exec_path", &config.exec_path)?;

        let arg_cstrings: Vec<CString> = config
            .exec_args
            .iter()
            .map(|a| cstring("exec_args", a))
            .collect::<Result<_, _>>()?;
        let argv_ptrs = null_terminated_ptrs(&arg_cstrings);

        let env_cstrings: Vec<CString> = config
            .env
            .iter()
            .map(|(k, v)| cstring("env", &format!("{k}={v}")))
            .collect::<Result<_, _>>()?;
        let envp_ptrs = null_terminated_ptrs(&env_cstrings);

        check(
            "krun_set_exec",
            krun_set_exec(
                ctx_id,
                exec_c.as_ptr(),
                argv_ptrs.as_ptr(),
                envp_ptrs.as_ptr(),
            ),
        )?;

        // Final call. Does not return on success — see this function's doc
        // comment. Only reachable here means libkrun rejected the fully
        // assembled configuration before ever starting the VM.
        let start_code = krun_start_enter(ctx_id);
        Err(BootError::Krun {
            call: "krun_start_enter",
            code: start_code,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn null_terminated_ptrs_appends_exactly_one_null() {
        let cstrings = vec![CString::new("a").unwrap(), CString::new("bb").unwrap()];
        let ptrs = null_terminated_ptrs(&cstrings);
        assert_eq!(ptrs.len(), 3);
        assert!(!ptrs[0].is_null());
        assert!(!ptrs[1].is_null());
        assert!(ptrs[2].is_null());
    }

    #[test]
    fn null_terminated_ptrs_of_empty_slice_is_just_the_terminator() {
        let cstrings: Vec<CString> = Vec::new();
        let ptrs = null_terminated_ptrs(&cstrings);
        assert_eq!(ptrs.len(), 1);
        assert!(ptrs[0].is_null());
    }

    #[test]
    fn null_terminated_ptrs_roundtrip_via_cstr() {
        let cstrings = vec![CString::new("hello").unwrap()];
        let ptrs = null_terminated_ptrs(&cstrings);
        // SAFETY: ptrs[0] was taken from cstrings[0], which is still alive.
        let back = unsafe { std::ffi::CStr::from_ptr(ptrs[0]) };
        assert_eq!(back.to_str().unwrap(), "hello");
    }

    #[test]
    fn cstring_rejects_interior_nul() {
        let err = cstring("field", "a\0b").unwrap_err();
        assert!(matches!(err, BootError::NulByte { field: "field" }));
    }

    #[test]
    fn check_maps_negative_to_err() {
        let err = check("some_call", -22).unwrap_err();
        match err {
            BootError::Krun { call, code } => {
                assert_eq!(call, "some_call");
                assert_eq!(code, -22);
            }
            other => panic!("expected Krun, got {other:?}"),
        }
    }

    #[test]
    fn check_maps_zero_and_positive_to_ok() {
        assert!(check("some_call", 0).is_ok());
        assert!(check("some_call", 7).is_ok());
    }

    #[test]
    fn boot_error_display_includes_call_and_errno_text() {
        let err = BootError::Krun {
            call: "krun_set_root",
            code: -2,
        }; // -ENOENT
        let msg = err.to_string();
        assert!(msg.contains("krun_set_root"), "message was: {msg}");
        assert!(msg.contains("-2"), "message was: {msg}");
    }
}
