//! Placeholder guest-side vsock client scaffold.
//!
//! TODO(task_2d6c): replace this stub with the real guest-side `AF_VSOCK`
//! client that relays Pi's loopback TCP traffic to the host per-job gateway
//! over vsock, per `docs/design/rust-adoption.md` scope item 1 — the proven
//! prototype lives at `spike/m8-a1/vsock-client/` and should inform (but
//! this crate does not yet contain) the real implementation. Once that
//! lands, this binary gets baked into the reviewer image (replacing
//! `docker/reviewer/forwarder.mjs`) and is covered by the image's digest pin
//! + cosign signature rather than being signed standalone.
//!
//! Until then, this binary's only job is to prove that the `rust/` cargo
//! workspace produces a real, statically-linked musl binary that the CI
//! pipeline (RUST-2 / task_2a18) can build for both target arches and, for
//! anything shipped outside the reviewer image, cosign-sign. It performs no
//! vsock I/O.

use vsock_framing::encode_frame;

fn main() {
    // Link against the shared framing crate and do real (if trivial) work,
    // so this isn't just an empty `fn main() {}` proving nothing about the
    // build pipeline.
    let framed = encode_frame(b"magpie-vsock-client placeholder - see task_2d6c")
        .expect("placeholder payload is well within MAX_FRAME_LEN");
    println!(
        "magpie-vsock-client scaffold OK: framed {} bytes (real vsock client is task_2d6c)",
        framed.len()
    );
}
