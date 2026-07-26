#!/usr/bin/env bash
# Assertion 3 (parallel half), raw direct-dial variant: N one-shot
# /vsock-client processes fired concurrently in the guest against the same
# uds_path/host listener (which must accept N connections, order
# unconstrained). Complements run-diag-oneshot-loop.sh's sequential proof.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPIKE_M8A1_DIR="$REPO_ROOT/spike/m8-a1"
M8C2_DIR="$REPO_ROOT/spike/m8-c2"
BIN="$REPO_ROOT/rust/target/release/magpie-krun-launch"
ROOTFS="$SPIKE_M8A1_DIR/rootfs"

install -m 0755 "$M8C2_DIR/m8c2-parallel-oneshot.sh" "$ROOTFS/m8c2-parallel-oneshot.sh"

WORKDIR="$(mktemp -d /tmp/magpie-m8c2-parallel.XXXXXX)"
JOB_DIR="$WORKDIR/job-parallel"
UDS_PATH="$JOB_DIR/gw.sock"
LISTENER_LOG="$WORKDIR/host-listener.log"
GUEST_LOG="$WORKDIR/guest.log"
trap 'kill "${LISTENER_PID:-0}" 2>/dev/null || true; rm -rf "$WORKDIR"' EXIT

COUNT=5
python3 "$M8C2_DIR/gw-stub-listener-oneshot-multi.py" "$UDS_PATH" par "$COUNT" >"$LISTENER_LOG" 2>&1 &
LISTENER_PID=$!
for _ in $(seq 1 50); do
    [ -S "$UDS_PATH" ] && break
    sleep 0.1
done

echo "=== booting micro-VM: $COUNT PARALLEL one-shot /vsock-client dials ===" >&2
set +e
sg kvm -c "'$BIN' --rootfs '$ROOTFS' --exec /bin/sh --arg /m8c2-parallel-oneshot.sh --arg 1234 --arg $COUNT \
    --vcpus 2 --ram-mib 512 --uid \$(id -u) --gid \$(id -g) \
    --vsock-port 1234 --vsock-uds '$UDS_PATH'" 2>&1 | tee "$GUEST_LOG"
set -e

echo "=== host listener log ===" >&2
cat "$LISTENER_LOG" >&2

ok_count=$(grep -c 'vsock round-trip OK' "$GUEST_LOG" || true)
echo "guest reported $ok_count/$COUNT successful PARALLEL round-trips" >&2
if [ "$ok_count" -eq "$COUNT" ]; then
    echo "PASS: all $COUNT parallel one-shot vsock dials round-tripped successfully" >&2
else
    echo "FAIL: only $ok_count/$COUNT parallel one-shot vsock dials round-tripped" >&2
    exit 1
fi
