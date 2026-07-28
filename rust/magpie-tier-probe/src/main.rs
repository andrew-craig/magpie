//! `magpie-tier-probe` -- install-time and runtime KVM preflight for the
//! isolation-tier ladder (M8-D1 / `task_2f46`; see
//! `docs/design/cto-decision-brief.md` §5's ladder: micro-VM (KVM) > gVisor
//! (deferred, `task_624d`) > hardened crun).
//!
//! # Why this actually opens `/dev/kvm` and issues `KVM_CREATE_VM`
//!
//! The brief's "tier honesty" invariant (§5) is explicit: probe `/dev/kvm`
//! by *actually opening it and issuing a trivial `KVM_CREATE_VM`* -- NOT by
//! reading CPUID registers, which can misreport whether the host can really
//! run a KVM guest. CPUID can claim virtualization extensions on a host
//! where KVM itself then refuses to create a VM (nested-virt-disabled-one-
//! level-up is the classic case) -- exactly the silent-degradation failure
//! mode `docs/design/cto-decision-brief.md` §5's "tier honesty" invariant
//! exists to catch. `KVM_CREATE_VM` is the one call that answers "can this
//! host run a KVM guest RIGHT NOW", not "does this CPU claim it could".
//!
//! # Why a standalone Rust binary, not a Node check
//!
//! Node has no `ioctl()` primitive, so this check can only be done by a
//! native helper (RUST-1, see `docs/design/rust-adoption.md`). This crate is
//! deliberately the smallest possible one: one syscall sequence, one
//! dependency (`libc`, already used by `vsock-client` and
//! `magpie-microvm-launcher`), no KVM-crate wrapper -- a wrapper would bury
//! the exact ioctl behind an abstraction this probe exists specifically to
//! keep auditable in ~5 lines.
//!
//! # Two callers, one contract
//!
//! - The **installer** (`task_67aa` / M8-D3) runs this binary directly, with
//!   NO Node in the loop at all -- this is why the output contract below is
//!   "exit code + one line of machine-readable JSON on stdout", not a
//!   library export only Node could consume.
//! - The **orchestrator** (`packages/orchestrator/src/tier-ladder.ts`, this
//!   same task) shells out to it exactly the same way, at startup, and
//!   parses the same JSON. Neither caller gets special treatment -- both
//!   read the identical contract, so there is exactly one code path to
//!   audit for "did we really check KVM_CREATE_VM".
//!
//! # What the probe does
//!
//! 1. `open("/dev/kvm", O_RDWR | O_CLOEXEC)` -- absence (no such device) or
//!    a permission error (invoking user not in the `kvm` group) is a normal,
//!    expected "this host has no usable KVM" result, not a crash: the whole
//!    point of the ladder is to keep going at a weaker tier in this case.
//! 2. `ioctl(kvm_fd, KVM_CREATE_VM, 0)` -- the real VM-creation call. `0` for
//!    the machine-type argument requests the default machine type
//!    everywhere (matching every other KVM-using component in this repo --
//!    `rust/magpie-microvm-launcher` goes through libkrun, which makes the
//!    equivalent call with the same default).
//! 3. Close the resulting VM fd, then the `/dev/kvm` fd -- leave nothing
//!    behind. (This probe only ever proves a VM CAN be created; it never
//!    boots anything, so there is nothing else to tear down.)
//!
//! # Output contract
//!
//! Exactly one line of JSON on stdout, always, regardless of outcome:
//! `{"kvm":<bool>,"reason":<string-or-null>}`. `reason` is `null` iff
//! `kvm:true`; a short human-readable string otherwise. Exit code `0` iff
//! `kvm:true`; `1` iff `kvm:false` (an ordinary, EXPECTED "not available"
//! result on a host with no hardware virtualization -- this is not treated
//! as a probe failure, only as a negative answer). stderr carries a short
//! human-readable echo of the same result for a human running this by hand.

use std::ffi::CString;
use std::os::unix::io::RawFd;

/// From `<linux/kvm.h>`: the `KVMIO` ioctl "type" byte all KVM ioctl numbers
/// are built from.
const KVMIO: u64 = 0xAE;

/// `<linux/kvm.h>`'s `#define KVM_CREATE_VM _IO(KVMIO, 0x01)`. `_IO(type, nr)`
/// (a no-argument-direction, no-size ioctl) reduces to `(type << 8) | nr`,
/// which is what's hand-encoded below. Encoded here rather than pulled from
/// a `kvm-ioctls`-style crate so the exact syscall this binary makes stays
/// visible in this file, not hidden behind a dependency -- see the module
/// doc comment's "one dependency" rationale. Pinned against the literal
/// `0xAE01` by `kvm_create_vm_matches_linux_kvm_h_encoding` below so a typo
/// in this hand-encoding is caught by `cargo test`, not only at real-ioctl
/// time on a KVM-capable host.
const KVM_CREATE_VM: u64 = (KVMIO << 8) | 0x01;

/// The device this whole probe exists to open. Not `/dev/kvm0` or any
/// per-accelerator variant -- this is the one path every KVM-capable Linux
/// host exposes.
const KVM_DEVICE_PATH: &str = "/dev/kvm";

/// Result of {@link probe_kvm}. `kvm:true` implies `reason:None` and vice
/// versa -- pinned by `probe_kvm_never_panics_and_is_internally_consistent`
/// below.
struct ProbeOutcome {
    kvm: bool,
    reason: Option<String>,
}

/// Opens `/dev/kvm` and issues `KVM_CREATE_VM`. Never panics: every failure
/// mode (missing device, permission denied, ioctl rejected) becomes
/// `ProbeOutcome { kvm: false, reason: Some(..) }` rather than an abort --
/// this is meant to run unattended inside an installer and inside the
/// orchestrator's own startup preflight, where "KVM isn't available" is an
/// ordinary, expected outcome on plenty of real hosts, not an exceptional
/// one.
fn probe_kvm() -> ProbeOutcome {
    let path = match CString::new(KVM_DEVICE_PATH) {
        Ok(p) => p,
        Err(err) => {
            // KVM_DEVICE_PATH is a fixed literal with no interior NUL --
            // this branch cannot actually happen, but `CString::new` returns
            // a `Result` so it must be handled somehow; fail closed rather
            // than `.unwrap()` and let it panic.
            return ProbeOutcome {
                kvm: false,
                reason: Some(format!(
                    "internal error building {KVM_DEVICE_PATH:?} path: {err}"
                )),
            };
        }
    };

    // SAFETY: `path` is a valid, NUL-terminated C string for the duration of
    // this call (it's not dropped until this function returns), and `open`
    // is being called with a plain path + flags, no output pointers this
    // code needs to further validate.
    let kvm_fd: RawFd = unsafe { libc::open(path.as_ptr(), libc::O_RDWR | libc::O_CLOEXEC) };
    if kvm_fd < 0 {
        let err = std::io::Error::last_os_error();
        return ProbeOutcome {
            kvm: false,
            reason: Some(format!("open({KVM_DEVICE_PATH}) failed: {err}")),
        };
    }

    // SAFETY: `kvm_fd` was just opened successfully above and is closed
    // exactly once, on every path out of this function, below.
    let vm_fd: libc::c_int = unsafe { libc::ioctl(kvm_fd, KVM_CREATE_VM as libc::Ioctl, 0) };
    let outcome = if vm_fd < 0 {
        let err = std::io::Error::last_os_error();
        ProbeOutcome {
            kvm: false,
            reason: Some(format!("KVM_CREATE_VM ioctl failed: {err}")),
        }
    } else {
        // SAFETY: `vm_fd` is a valid fd returned by the ioctl above; closed
        // immediately since this probe only needs to prove a VM CAN be
        // created, never boots anything.
        unsafe {
            libc::close(vm_fd);
        }
        ProbeOutcome {
            kvm: true,
            reason: None,
        }
    };

    // SAFETY: `kvm_fd` is still open and owned by this function; close it
    // exactly once, regardless of which branch above ran.
    unsafe {
        libc::close(kvm_fd);
    }
    outcome
}

/// Hand-rolled JSON emission for {@link ProbeOutcome}'s two known-shape
/// fields -- pulling in `serde_json` for one call site would be the same
/// "heavyweight dependency for a single check" the module doc comment
/// argues against for KVM wrapper crates. `reason`, when present, is built
/// entirely from this process's own literals and
/// `std::io::Error::last_os_error()` text (kernel/libc-controlled, not
/// attacker input), so covering just `"`, `\`, and newlines is sufficient.
fn to_json(outcome: &ProbeOutcome) -> String {
    let reason = match &outcome.reason {
        Some(r) => format!("\"{}\"", escape_json(r)),
        None => "null".to_string(),
    };
    format!("{{\"kvm\":{},\"reason\":{}}}", outcome.kvm, reason)
}

/// Escapes the three characters that could otherwise break the hand-rolled
/// JSON string in {@link to_json}. Not a general-purpose JSON escaper --
/// scoped exactly to what `std::io::Error`'s `Display` text can plausibly
/// contain.
fn escape_json(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

fn main() {
    let outcome = probe_kvm();
    // stdout: the machine-readable contract both callers (installer shell
    // script, orchestrator's tier-ladder.ts) parse. Always emitted, on
    // every path, before the process exits.
    println!("{}", to_json(&outcome));
    if outcome.kvm {
        eprintln!("[magpie-tier-probe] KVM available (KVM_CREATE_VM succeeded)");
        std::process::exit(0);
    } else {
        eprintln!(
            "[magpie-tier-probe] KVM unavailable: {}",
            outcome.reason.as_deref().unwrap_or("unknown reason")
        );
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kvm_create_vm_matches_linux_kvm_h_encoding() {
        // From <linux/kvm.h>: `KVM_CREATE_VM` is `_IO(KVMIO, 0x01)` with
        // KVMIO = 0xAE; `_IO`'s dir=0/size=0 encoding reduces to
        // `(type << 8) | nr`. Pinned as a literal so a typo in the
        // hand-encoding above is caught here, not only at real-ioctl time on
        // a KVM-capable host.
        assert_eq!(KVM_CREATE_VM, 0xAE01);
    }

    #[test]
    fn to_json_true_has_null_reason() {
        let outcome = ProbeOutcome {
            kvm: true,
            reason: None,
        };
        assert_eq!(to_json(&outcome), "{\"kvm\":true,\"reason\":null}");
    }

    #[test]
    fn to_json_false_quotes_and_escapes_reason() {
        let outcome = ProbeOutcome {
            kvm: false,
            reason: Some("open(\"/dev/kvm\") failed: no such file\nline2".to_string()),
        };
        let json = to_json(&outcome);
        assert_eq!(
            json,
            "{\"kvm\":false,\"reason\":\"open(\\\"/dev/kvm\\\") failed: no such file\\nline2\"}"
        );
    }

    #[test]
    fn probe_kvm_never_panics_and_is_internally_consistent() {
        // Runs on whatever host `cargo test` executes on -- generic CI
        // runners typically have no /dev/kvm at all; a real KVM-capable
        // host (this task's arm64 target) does. Either way the contract
        // this test pins is host-independent: `kvm:false` always carries a
        // `reason`, `kvm:true` never does, and the probe never panics.
        let outcome = probe_kvm();
        assert_eq!(outcome.kvm, outcome.reason.is_none());
    }
}
