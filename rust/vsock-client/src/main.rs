//! `magpie-vsock-client` — the guest-side `AF_VSOCK` relay (M8-C1 / `task_2d6c`).
//!
//! # Role
//!
//! Inside the Magpie reviewer micro-VM guest, Pi is pointed at
//! `http://127.0.0.1:4000/v1` (see `docker/reviewer/entrypoint.sh`'s
//! `~/.pi/agent/models.json` translation of `OPENAI_BASE_URL` — Pi's own
//! invocation is unaware any of this exists). Under the docker/crun reviewer
//! today, `docker/reviewer/forwarder.mjs` makes that address real by
//! listening on the container's own loopback (left intact by `--network
//! none`) and relaying each TCP connection to a bind-mounted unix socket.
//! Under a libkrun micro-VM, there is no shared host filesystem to bind-mount
//! a socket from — the guest's only channel to the host is the `AF_VSOCK`
//! device the launcher attaches unconditionally
//! (`rust/magpie-microvm-launcher/src/krun.rs`'s `krun_add_vsock` /
//! `krun_add_vsock_port2`, TSI off). This binary is the vsock-side
//! equivalent of `forwarder.mjs`: same TCP address, same per-connection
//! relay contract, different destination transport.
//!
//! # Why no framing library
//!
//! An early plan speculated this client would need to length-prefix-frame
//! Pi's traffic before relaying it, which briefly motivated a standalone
//! `vsock-framing` scaffolding crate (since removed — it never gained a
//! consumer). That framing turned out to be unnecessary and actively wrong
//! for this shape: Pi's traffic is plain HTTP, already self-delimiting, and
//! the M8-A1 spike addendum proved `AF_VSOCK` supports ordinary
//! per-connection semantics (each `connect()` is a distinct byte stream,
//! exactly like `AF_UNIX`/TCP) — so the correct relay is a 1:1 "new vsock
//! connection per accepted TCP connection" raw byte pipe, identical in shape
//! to `forwarder.mjs`'s `tcpConn.pipe(unixConn)`. The host-side forwarder
//! (`task_b3f7`) resolved the same way — a plain byte relay, no frame format
//! to decode.
//!
//! # Fail-closed startup
//!
//! Before opening the TCP listener at all, this binary:
//!   1. asserts `/dev/vsock` exists and is a character device (the guest's
//!      only permitted egress path — absent means this guest has no vsock
//!      device attached at all, e.g. it was booted without
//!      `krun_add_vsock`);
//!   2. performs a bounded-retry preflight `connect()` to the configured
//!      vsock port, so a host side that isn't listening yet (or never will
//!      be) is caught before Pi ever gets a chance to dial 127.0.0.1:4000
//!      and hang.
//!
//! Either failure exits non-zero with a clear stderr message and starts
//! nothing — consistent with `docker/reviewer/entrypoint.sh`'s existing
//! fail-closed confinement-assertion pattern (network canaries, gateway
//! `/healthz` probe) for the docker/crun path.
//!
//! # Vsock port convention
//!
//! Job isolation comes from the per-VM CID (each micro-VM is its own guest,
//! its own vsock address space), not from the port — `task_b3f7`'s per-job
//! host-side socket is selected by `uds_path`, not by a per-job port. So a
//! single well-known port is expected to be the real, final convention; this
//! binary still allows overriding it (`MAGPIE_VSOCK_PORT` env var, or an
//! optional `argv[1]`, mirroring `forwarder.mjs`'s optional `argv[2]`
//! socket-path override) since the launcher-side wiring (task_39ff) that
//! fixes the production value hasn't landed yet.

use std::io::{self, Read, Write};
use std::mem::size_of;
use std::net::{Shutdown, TcpListener, TcpStream};
use std::os::fd::RawFd;
use std::os::unix::fs::FileTypeExt;
use std::path::Path;
use std::thread;
use std::time::Duration;

/// Loopback address/port Pi's `OPENAI_BASE_URL` targets. Fixed — this is an
/// external contract with Pi's config (see the module doc comment), not
/// something a deployment should ever need to override.
const TCP_HOST: &str = "127.0.0.1";
const TCP_PORT: u16 = 4000;

/// Default vsock port the guest dials if not overridden. Matches the value
/// `rust/magpie-microvm-launcher/smoke-test.sh` uses for `--vsock-port` and
/// the M8-A1 spike's default — see the module doc comment's "Vsock port
/// convention" section for why a fixed, well-known port is expected to be
/// the eventual real value.
const DEFAULT_VSOCK_PORT: u32 = 1234;

/// Character device whose presence is this guest's proof it has an
/// `AF_VSOCK` device attached at all.
const VSOCK_DEVICE_PATH: &str = "/dev/vsock";

/// Bounded retries for both the startup preflight connect and each accepted
/// connection's own dial. Mirrors `forwarder.mjs`'s `MAX_RETRIES = 5`.
const MAX_CONNECT_RETRIES: u32 = 5;

/// Base backoff delay; doubles per attempt (`RETRY_BASE_MS * 2^attempt`).
/// Mirrors `forwarder.mjs`'s `RETRY_BASE_MS = 100`.
const RETRY_BASE_MS: u64 = 100;

fn log(msg: &str) {
    eprintln!("[vsock-client] {msg}");
}

fn main() {
    let port = match vsock_port_from(
        std::env::args().nth(1).as_deref(),
        std::env::var("MAGPIE_VSOCK_PORT").ok().as_deref(),
    ) {
        Ok(port) => port,
        Err(reason) => {
            log(&format!("refusing to start: {reason}"));
            std::process::exit(1);
        }
    };

    if let Err(reason) = assert_char_device_present(Path::new(VSOCK_DEVICE_PATH)) {
        log(&format!(
            "refusing to start: {reason} -- this guest's only permitted egress path is unavailable"
        ));
        std::process::exit(1);
    }

    match connect_with_retry(port, MAX_CONNECT_RETRIES) {
        Ok(preflight) => {
            // Only proving reachability -- drop the connection, real traffic
            // dials fresh per accepted TCP connection below (matching
            // forwarder.mjs's one-unix-dial-per-tcp-connection shape).
            drop(preflight);
            log(&format!("preflight vsock connect to host port {port} OK"));
        }
        Err(err) => {
            log(&format!(
                "refusing to start: preflight vsock connect to host port {port} failed after \
                 {MAX_CONNECT_RETRIES} retries: {err}"
            ));
            std::process::exit(1);
        }
    }

    let listener = match TcpListener::bind((TCP_HOST, TCP_PORT)) {
        Ok(listener) => listener,
        Err(err) => {
            log(&format!("listen error: {err}"));
            std::process::exit(1);
        }
    };
    log(&format!(
        "listening on {TCP_HOST}:{TCP_PORT} -> vsock cid=host port={port}"
    ));

    for conn in listener.incoming() {
        match conn {
            Ok(tcp) => {
                thread::spawn(move || handle_connection(tcp, port));
            }
            Err(err) => log(&format!("accept error: {err}")),
        }
    }
}

/// Resolves the vsock port from (in priority order) an explicit CLI arg, the
/// `MAGPIE_VSOCK_PORT` env var, then [`DEFAULT_VSOCK_PORT`] when neither is
/// set.
///
/// A source that is *present but unparseable* is a hard error (`Err`), NOT a
/// silent fall-through to the next source or the default: a typo'd override
/// (e.g. `MAGPIE_VSOCK_PORT=123o`) is a misconfiguration, and silently dialing
/// 1234 instead would mask it -- inconsistent with this binary's otherwise
/// strict fail-closed posture (the preflight connect only catches an
/// *unreachable* port, not a wrong-but-reachable one). An *absent* source is
/// fine and defers to the next: no override set at all is the normal case.
/// The higher-priority arg wins over env only when arg is absent; a present
/// arg is authoritative and must parse.
fn vsock_port_from(arg: Option<&str>, env: Option<&str>) -> Result<u32, String> {
    let parse = |value: &str, source: &str| {
        value
            .parse::<u32>()
            .map_err(|err| format!("{source} value {value:?} is not a valid vsock port ({err})"))
    };
    match (arg, env) {
        (Some(arg), _) => parse(arg, "vsock port argument"),
        (None, Some(env)) => parse(env, "MAGPIE_VSOCK_PORT"),
        (None, None) => Ok(DEFAULT_VSOCK_PORT),
    }
}

/// True iff `path` exists and is a character device. Parameterized (rather
/// than hardcoding [`VSOCK_DEVICE_PATH`]) so tests can point it at `/dev/null`
/// (present on every Linux CI runner, no root/hardware required) instead of
/// needing a real vsock device.
fn assert_char_device_present(path: &Path) -> Result<(), String> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.file_type().is_char_device() => Ok(()),
        Ok(_) => Err(format!(
            "{} exists but is not a character device",
            path.display()
        )),
        Err(err) => Err(format!(
            "{} is absent or inaccessible ({err})",
            path.display()
        )),
    }
}

/// Runs `attempt_fn` up to `max_retries + 1` times with doubling backoff
/// (`RETRY_BASE_MS * 2^attempt` between attempts), returning the first `Ok`
/// or the last `Err` once retries are exhausted. Pure retry-loop logic,
/// independent of what's actually being retried, so it's unit-testable with
/// a zero-delay closure instead of real vsock I/O or real sleeps.
fn retry_with_backoff<T, E>(
    max_retries: u32,
    base_delay: Duration,
    mut attempt_fn: impl FnMut(u32) -> Result<T, E>,
) -> Result<T, E> {
    let mut attempt = 0;
    loop {
        match attempt_fn(attempt) {
            Ok(value) => return Ok(value),
            Err(err) => {
                if attempt >= max_retries {
                    return Err(err);
                }
                let delay = base_delay * 2u32.pow(attempt);
                thread::sleep(delay);
                attempt += 1;
            }
        }
    }
}

fn connect_with_retry(port: u32, max_retries: u32) -> io::Result<VsockStream> {
    retry_with_backoff(
        max_retries,
        Duration::from_millis(RETRY_BASE_MS),
        |attempt| {
            VsockStream::connect(port).map_err(|err| {
                log(&format!(
                    "connect to vsock port {port} failed (attempt {}/{}): {err}",
                    attempt + 1,
                    max_retries + 1
                ));
                err
            })
        },
    )
}

/// Handles one accepted Pi->relay TCP connection: dials a fresh vsock
/// connection (bounded retry) and relays bytes bidirectionally until either
/// side closes. Failures here are scoped to this one connection -- they
/// never take down the listener or other in-flight connections, mirroring
/// `forwarder.mjs`'s per-connection `.catch()`.
fn handle_connection(tcp: TcpStream, port: u32) {
    let vsock = match connect_with_retry(port, MAX_CONNECT_RETRIES) {
        Ok(vsock) => vsock,
        Err(err) => {
            log(&format!(
                "giving up on vsock port {port} for this connection: {err}"
            ));
            let _ = tcp.shutdown(Shutdown::Both);
            return;
        }
    };
    log(&format!(
        "relaying connection -> vsock cid=host port={port}"
    ));
    relay(tcp, vsock);
}

/// Bidirectional relay between two half-closeable byte streams: copies
/// `a -> b` on a spawned thread and `b -> a` on the caller's thread, and
/// half-closes each destination's write side once its source hits EOF/error
/// (the "shutdown(SHUT_WR) before close" discipline the M8-A1 spike found
/// necessary to avoid a teardown race -- see
/// `spike/m8-a1/frontend-investigation.md`'s addendum). Any I/O error is
/// treated as "peer is gone" and simply ends that direction; teardown races
/// (either side already closed) are tolerated, matching `forwarder.mjs`'s
/// `once("close"/"error", teardown)` behavior.
fn relay<A: RelayHalf, B: RelayHalf>(mut a: A, mut b: B) {
    let a_to_b = match (a.try_clone_half(), b.try_clone_half()) {
        (Ok(a_read), Ok(b_write)) => Some((a_read, b_write)),
        _ => None,
    };

    let handle = a_to_b.map(|(mut a_read, mut b_write)| {
        thread::spawn(move || {
            let _ = io::copy(&mut a_read, &mut b_write);
            let _ = b_write.shutdown_write_half();
        })
    });

    let _ = io::copy(&mut b, &mut a);
    let _ = a.shutdown_write_half();

    if let Some(handle) = handle {
        let _ = handle.join();
    }
}

/// Shared shape for the two ends of a relayed connection ([`TcpStream`] and
/// [`VsockStream`]): a cloneable, half-closeable byte stream. Exists so
/// [`relay`] (and its tests) work identically whether the "other side" is a
/// real vsock connection or -- in tests -- a second loopback `TcpStream`
/// standing in for one, without needing real vsock hardware to exercise the
/// relay/copy/half-close logic.
trait RelayHalf: Read + Write + Send + 'static {
    fn try_clone_half(&self) -> io::Result<Self>
    where
        Self: Sized;
    fn shutdown_write_half(&self) -> io::Result<()>;
}

impl RelayHalf for TcpStream {
    fn try_clone_half(&self) -> io::Result<Self> {
        self.try_clone()
    }
    fn shutdown_write_half(&self) -> io::Result<()> {
        self.shutdown(Shutdown::Write)
    }
}

impl RelayHalf for VsockStream {
    fn try_clone_half(&self) -> io::Result<Self> {
        self.try_clone()
    }
    fn shutdown_write_half(&self) -> io::Result<()> {
        VsockStream::shutdown_write(self)
    }
}

/// A connected `AF_VSOCK` `SOCK_STREAM` socket to `VMADDR_CID_HOST`. Thin
/// wrapper over the raw fd (matching `spike/m8-a1/vsock-client/src/main.rs`'s
/// proven `socket`/`connect`/`sockaddr_vm` sequence) implementing
/// [`Read`]/[`Write`] via `read(2)`/`write(2)` so it composes with
/// `std::io::copy` exactly like a [`TcpStream`] does.
struct VsockStream {
    fd: RawFd,
}

impl VsockStream {
    /// Opens a new `AF_VSOCK` connection to `VMADDR_CID_HOST` (2 -- the
    /// host) on `port`. Mirrors the spike's proven call sequence exactly;
    /// see `spike/m8-a1/vsock-client/src/main.rs`.
    fn connect(port: u32) -> io::Result<Self> {
        // SAFETY: `addr` is a plain repr(C) struct populated entirely by
        // this function before use; `fd` is checked for `-1` immediately
        // after every syscall that can produce it, and is closed on every
        // error path before returning so no fd leaks on failure.
        unsafe {
            let fd = libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM, 0);
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }

            let mut addr: libc::sockaddr_vm = std::mem::zeroed();
            addr.svm_family = libc::AF_VSOCK as libc::sa_family_t;
            addr.svm_port = port;
            addr.svm_cid = libc::VMADDR_CID_HOST;

            let rc = libc::connect(
                fd,
                &addr as *const _ as *const libc::sockaddr,
                size_of::<libc::sockaddr_vm>() as libc::socklen_t,
            );
            if rc != 0 {
                let err = io::Error::last_os_error();
                libc::close(fd);
                return Err(err);
            }

            Ok(VsockStream { fd })
        }
    }

    /// Duplicates the underlying fd so the read half and write half can live
    /// on separate threads (mirrors `TcpStream::try_clone`'s contract:
    /// independent handles sharing one kernel socket).
    fn try_clone(&self) -> io::Result<Self> {
        // SAFETY: `dup` on a valid, open fd this struct owns; the returned
        // fd is a new, independently-owned descriptor per `dup(2)`'s
        // contract.
        let new_fd = unsafe { libc::dup(self.fd) };
        if new_fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(VsockStream { fd: new_fd })
    }

    /// Half-closes the write direction (`shutdown(fd, SHUT_WR)`), signalling
    /// EOF to the peer while still allowing reads on this handle -- the
    /// discipline the spike found necessary to avoid a teardown race (see
    /// [`relay`]'s doc comment).
    fn shutdown_write(&self) -> io::Result<()> {
        // SAFETY: `self.fd` is a valid, open socket fd for the lifetime of
        // `&self`.
        let rc = unsafe { libc::shutdown(self.fd, libc::SHUT_WR) };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

impl Read for VsockStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        // SAFETY: `buf` is a valid, exclusively-borrowed byte slice for the
        // duration of the call; `read(2)` writes at most `buf.len()` bytes
        // into it and returns the count actually written.
        let n = unsafe { libc::read(self.fd, buf.as_mut_ptr() as *mut _, buf.len()) };
        if n < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(n as usize)
        }
    }
}

impl Write for VsockStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // SAFETY: `buf` is a valid, borrowed byte slice for the duration of
        // the call; `write(2)` only ever reads from it.
        let n = unsafe { libc::write(self.fd, buf.as_ptr() as *const _, buf.len()) };
        if n < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(n as usize)
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for VsockStream {
    fn drop(&mut self) {
        // SAFETY: `self.fd` is a valid, open fd this struct exclusively
        // owns; closed at most once (Drop runs exactly once per value).
        unsafe {
            libc::close(self.fd);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    // --- vsock_port_from ----------------------------------------------

    #[test]
    fn port_defaults_when_nothing_set() {
        assert_eq!(vsock_port_from(None, None), Ok(DEFAULT_VSOCK_PORT));
    }

    #[test]
    fn port_from_arg_takes_priority_over_env() {
        assert_eq!(vsock_port_from(Some("42"), Some("99")), Ok(42));
    }

    #[test]
    fn port_falls_back_to_env_when_no_arg() {
        assert_eq!(vsock_port_from(None, Some("99")), Ok(99));
    }

    #[test]
    fn unparseable_arg_is_a_hard_error_even_when_env_is_valid() {
        // A present-but-malformed explicit override must fail loudly rather
        // than silently masking the typo by falling through to env/default --
        // the arg is authoritative and must parse.
        let err = vsock_port_from(Some("not-a-number"), Some("99")).unwrap_err();
        assert!(err.contains("vsock port argument"), "{err}");
        assert!(err.contains("not-a-number"), "{err}");
    }

    #[test]
    fn unparseable_env_is_a_hard_error() {
        let err = vsock_port_from(None, Some("also-nope")).unwrap_err();
        assert!(err.contains("MAGPIE_VSOCK_PORT"), "{err}");
        assert!(err.contains("also-nope"), "{err}");
    }

    // --- assert_char_device_present ------------------------------------

    #[test]
    fn dev_null_is_a_char_device() {
        // /dev/null exists on every Linux CI runner and requires no root or
        // real vsock hardware -- stands in for /dev/vsock's shape check.
        assert!(assert_char_device_present(Path::new("/dev/null")).is_ok());
    }

    #[test]
    fn missing_path_is_rejected() {
        let err = assert_char_device_present(Path::new("/nonexistent/path/for/magpie/tests"))
            .unwrap_err();
        assert!(err.contains("absent or inaccessible"), "{err}");
    }

    #[test]
    fn regular_file_is_rejected() {
        let tmp =
            std::env::temp_dir().join(format!("magpie-vsock-client-test-{}", std::process::id()));
        std::fs::write(&tmp, b"not a device").unwrap();
        let err = assert_char_device_present(&tmp).unwrap_err();
        std::fs::remove_file(&tmp).ok();
        assert!(err.contains("not a character device"), "{err}");
    }

    // --- retry_with_backoff --------------------------------------------

    #[test]
    fn retry_returns_first_success_without_retrying() {
        let mut attempts = 0;
        let result: Result<u32, &str> = retry_with_backoff(5, Duration::ZERO, |_| {
            attempts += 1;
            Ok(7)
        });
        assert_eq!(result, Ok(7));
        assert_eq!(attempts, 1);
    }

    #[test]
    fn retry_gives_up_after_max_retries_and_returns_last_error() {
        let mut attempts = 0;
        let result: Result<u32, &str> = retry_with_backoff(3, Duration::ZERO, |attempt| {
            attempts += 1;
            Err(if attempt == 3 { "final" } else { "not yet" })
        });
        assert_eq!(result, Err("final"));
        // max_retries=3 means attempts 0,1,2,3 -- four tries total.
        assert_eq!(attempts, 4);
    }

    #[test]
    fn retry_succeeds_partway_through() {
        let mut attempts = 0;
        let result: Result<u32, &str> = retry_with_backoff(5, Duration::ZERO, |attempt| {
            attempts += 1;
            if attempt < 2 {
                Err("not yet")
            } else {
                Ok(99)
            }
        });
        assert_eq!(result, Ok(99));
        assert_eq!(attempts, 3);
    }

    // --- relay (over a loopback TCP pair standing in for tcp/vsock legs) --

    /// Connects two fresh, already-paired `TcpStream`s over real loopback
    /// sockets -- used to stand in for BOTH legs of [`relay`] in tests, so
    /// the copy/half-close logic is exercised without needing a real vsock
    /// device (unavailable on generic CI runners).
    fn tcp_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let client = TcpStream::connect(addr).unwrap();
        let (server, _) = listener.accept().unwrap();
        (client, server)
    }

    #[test]
    fn relay_copies_bytes_in_both_directions() {
        let (a_near, a_far) = tcp_pair();
        let (b_near, b_far) = tcp_pair();

        let relay_thread = thread::spawn(move || relay(a_far, b_far));

        // a_near writes "ping" -> should arrive on b_near (a -> b direction).
        let mut a_near = a_near;
        let mut b_near = b_near;
        a_near.write_all(b"ping").unwrap();
        a_near.shutdown(Shutdown::Write).unwrap();
        let mut got = [0u8; 4];
        b_near.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"ping");

        // b_near writes "pong" -> should arrive on a_near (b -> a direction).
        b_near.write_all(b"pong").unwrap();
        b_near.shutdown(Shutdown::Write).unwrap();
        let mut got2 = [0u8; 4];
        a_near.read_exact(&mut got2).unwrap();
        assert_eq!(&got2, b"pong");

        relay_thread.join().unwrap();
    }

    #[test]
    fn relay_propagates_half_close() {
        let (a_near, a_far) = tcp_pair();
        let (b_near, b_far) = tcp_pair();

        let relay_thread = thread::spawn(move || relay(a_far, b_far));

        let a_near = a_near;
        let mut b_near = b_near;
        // a_near closes immediately with no data -- b_near should observe
        // EOF (0-byte read) once the relay propagates the half-close.
        a_near.shutdown(Shutdown::Write).unwrap();
        let mut buf = [0u8; 1];
        let n = b_near.read(&mut buf).unwrap();
        assert_eq!(n, 0, "expected EOF on b_near after a_near half-closed");

        drop(b_near);
        drop(a_near);
        relay_thread.join().unwrap();
    }

    #[test]
    fn relay_tolerates_peer_already_gone() {
        // One side is dropped immediately (simulating a teardown race) --
        // relay must not panic, just return once both directions error out.
        let (a_near, a_far) = tcp_pair();
        let (b_near, b_far) = tcp_pair();
        drop(a_near);
        drop(b_near);
        relay(a_far, b_far);
    }
}
