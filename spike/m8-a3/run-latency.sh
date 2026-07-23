#!/usr/bin/env bash
# M8-A3 spike (task_a163) — latency measurement runner.
#
# Measures connection-setup + streaming round-trip latency of the
# guest -> vsock -> host per-job unix-socket path (the M8 microVM gateway channel
# shape) and compares it to a plain host<->host unix-socket baseline (the
# transport Magpie uses today), using the SAME static musl bench binary and the
# SAME host-side echo server for both, so the only variable is the transport.
#
# Reuses the already-built M8-A1 artifacts:
#   - libkrun/crun installed at /usr/local (see spike/m8-a1/provision.sh)
#   - the direct-libkrun launcher  spike/m8-a1/magpie-krun-launch
#   - the reviewer rootfs          spike/m8-a1/rootfs/
# and this spike's bench binary (built for aarch64-musl, copied into the rootfs).
#
# /dev/kvm is accessed via the `kvm` group using `sg kvm -c` exactly as the
# M8-A1 spike did. No number is fabricated: this script only runs the binary and
# tees its RESULT lines to a log; every figure in the findings comes from here.
set -euo pipefail

SPIKE_A3="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPIKE_A1="$(cd "$SPIKE_A3/../m8-a1" && pwd)"

LAUNCH="$SPIKE_A1/magpie-krun-launch"
ROOTFS="$SPIKE_A1/rootfs"
# The bench binary must already be built and copied into the rootfs as
# /magpie-vsock-bench (see README). We reuse the same on-host copy for the
# native baseline so both sides run byte-identical code.
HOST_BIN="$ROOTFS/magpie-vsock-bench"

# Measurement parameters (override via env).
CONN_ITERS="${CONN_ITERS:-500}"
STREAM_MSGS="${STREAM_MSGS:-2000}"
MSG_BYTES="${MSG_BYTES:-256}"
VSOCK_PORT="${VSOCK_PORT:-1234}"

OUT="${OUT:-$SPIKE_A3/latency-run.log}"
: > "$OUT"

log() { echo "$@" | tee -a "$OUT"; }

for tool in "$LAUNCH" "$HOST_BIN"; do
    [ -x "$tool" ] || { echo "missing/executable: $tool" >&2; exit 1; }
done

log "# M8-A3 latency run $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "# host: $(uname -srm) pagesize=$(getconf PAGESIZE)"
log "# params: conn_iters=$CONN_ITERS stream_msgs=$STREAM_MSGS msg_bytes=$MSG_BYTES"
log "# bench binary: $(file -b "$HOST_BIN")"
log ""

# ---------------------------------------------------------------------------
# 1. Host<->host UNIX baseline (no VM). Native host client -> host echo server.
# ---------------------------------------------------------------------------
BASE_SOCK="/tmp/m8a3-baseline.sock"
rm -f "$BASE_SOCK"
"$HOST_BIN" serve "$BASE_SOCK" > /tmp/m8a3-serve-baseline.log 2>&1 &
BASE_SRV=$!
# wait for the server to announce it is listening
for _ in $(seq 1 50); do [ -S "$BASE_SOCK" ] && break; sleep 0.05; done
log "## baseline: host<->host unix socket"
"$HOST_BIN" bench-all unix "$BASE_SOCK" "$CONN_ITERS" "$STREAM_MSGS" "$MSG_BYTES" 2>&1 | tee -a "$OUT"
kill "$BASE_SRV" 2>/dev/null || true
wait "$BASE_SRV" 2>/dev/null || true
rm -f "$BASE_SOCK"
log ""

# ---------------------------------------------------------------------------
# 2. guest -> vsock -> host unix-socket path (via libkrun microVM).
#    Host echo server listens on the per-job unix socket; libkrun connects OUT
#    to it (krun_add_vsock_port2 listen=false) each time the guest dials the
#    vsock port. Guest runs the identical bench-all client over AF_VSOCK.
# ---------------------------------------------------------------------------
VSOCK_SOCK="/tmp/m8a3-vsock.sock"
rm -f "$VSOCK_SOCK"
"$HOST_BIN" serve "$VSOCK_SOCK" > /tmp/m8a3-serve-vsock.log 2>&1 &
VS_SRV=$!
for _ in $(seq 1 50); do [ -S "$VSOCK_SOCK" ] && break; sleep 0.05; done
log "## vsock: guest -> vsock -> host per-job unix socket (libkrun microVM)"
sg kvm -c "MAGPIE_VSOCK_UDS=$VSOCK_SOCK MAGPIE_VSOCK_PORT=$VSOCK_PORT $LAUNCH $ROOTFS /magpie-vsock-bench bench-all vsock $VSOCK_PORT $CONN_ITERS $STREAM_MSGS $MSG_BYTES" 2>&1 | tee -a "$OUT"
kill "$VS_SRV" 2>/dev/null || true
wait "$VS_SRV" 2>/dev/null || true
rm -f "$VSOCK_SOCK"
log ""
log "# done"
