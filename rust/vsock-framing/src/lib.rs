//! Shared length-prefixed framing helpers for `AF_VSOCK` byte streams.
//!
//! This crate is **scaffolding for RUST-2 (`task_2a18`)**: its job is to give
//! the cargo workspace + build/signing pipeline a real, non-empty, buildable
//! library crate to prove out against, per `docs/design/rust-adoption.md`
//! ("Build & signing" — "shared crates for vsock framing and confinement
//! assertions"). It is intentionally minimal.
//!
//! TODO(task_2d6c): the guest-side vsock client will use this to frame Pi's
//! loopback TCP traffic before relaying it over `AF_VSOCK` to the host
//! per-job gateway socket (see `spike/m8-a1/vsock-client/` for the proven
//! raw-socket prototype this crate does not yet replace).
//!
//! TODO(task_76d6): the host-side libkrun launcher's per-VM vsock<->gateway
//! forwarder will use this on the host side of the same connection.
//!
//! Do not extend this crate with real vsock I/O or launcher logic — that
//! belongs in the crates task_2d6c/task_76d6 add, which should depend on
//! this one rather than duplicate it.

/// Ceiling on a single frame's payload size. Placeholder value; revisit once
/// the real protocol (task_2d6c/task_76d6) sets actual requirements.
pub const MAX_FRAME_LEN: u32 = 1 << 20; // 1 MiB

/// Frame `payload` as a 4-byte big-endian length prefix followed by the
/// payload bytes.
pub fn encode_frame(payload: &[u8]) -> Result<Vec<u8>, FramingError> {
    let len = u32::try_from(payload.len()).map_err(|_| FramingError::TooLarge)?;
    if len > MAX_FRAME_LEN {
        return Err(FramingError::TooLarge);
    }
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

/// Decode a single length-prefixed frame from the front of `buf`.
///
/// Returns `Ok(Some((payload, consumed)))` when a full frame is present,
/// `Ok(None)` when `buf` holds an incomplete frame (the caller should read
/// more bytes and retry), or `Err` if the declared length exceeds
/// [`MAX_FRAME_LEN`].
pub fn decode_frame(buf: &[u8]) -> Result<Option<(&[u8], usize)>, FramingError> {
    if buf.len() < 4 {
        return Ok(None);
    }
    let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]);
    if len > MAX_FRAME_LEN {
        return Err(FramingError::TooLarge);
    }
    let total = 4 + len as usize;
    if buf.len() < total {
        return Ok(None);
    }
    Ok(Some((&buf[4..total], total)))
}

/// Errors from [`encode_frame`] / [`decode_frame`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FramingError {
    /// The payload (or declared length prefix) exceeds [`MAX_FRAME_LEN`].
    TooLarge,
}

impl std::fmt::Display for FramingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FramingError::TooLarge => write!(f, "frame exceeds MAX_FRAME_LEN"),
        }
    }
}

impl std::error::Error for FramingError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let payload = b"hello vsock";
        let framed = encode_frame(payload).unwrap();
        let (decoded, consumed) = decode_frame(&framed).unwrap().unwrap();
        assert_eq!(decoded, payload);
        assert_eq!(consumed, framed.len());
    }

    #[test]
    fn partial_buffer_returns_none() {
        let payload = b"hello vsock";
        let framed = encode_frame(payload).unwrap();
        assert_eq!(decode_frame(&framed[..framed.len() - 1]).unwrap(), None);
    }

    #[test]
    fn empty_buffer_returns_none() {
        assert_eq!(decode_frame(&[]).unwrap(), None);
    }

    #[test]
    fn oversized_len_prefix_rejected() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&(MAX_FRAME_LEN + 1).to_be_bytes());
        assert_eq!(decode_frame(&buf), Err(FramingError::TooLarge));
    }

    #[test]
    fn oversized_payload_rejected_on_encode() {
        // Cheap check without allocating a 1 MiB+ vec: length alone is enough
        // to trip the guard.
        let huge_len = (MAX_FRAME_LEN + 1) as usize;
        let payload = vec![0u8; huge_len];
        assert_eq!(encode_frame(&payload), Err(FramingError::TooLarge));
    }
}
