#!/usr/bin/env bash
# Diagnostic (not one of the 5 numbered spike assertions): repeats the
# KNOWN-GOOD baseline one-shot vsock round-trip 8 times sequentially in a
# single guest boot, to check whether repeated direct vsock dials to the
# same uds_path are reliable on their own, isolated from the newer Rust
# relay + node test-client stack used by run-assertion345.sh (which showed
# inconsistent results across repeated runs -- see direct-wiring-spike.md).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPIKE_M8A1_DIR="$REPO_ROOT/spike/m8-a1"
M8C2_DIR="$REPO_ROOT/spike/m8-c2"
BIN="$REPO_ROOT/rust/target/release/magpie-krun-launch"
ROOTFS="$SPIKE_M8A1_DIR/rootfs"

install -m 0755 "$M8C2_DIR/m8c2-oneshot-loop.sh" "$ROOTFS/m8c2-oneshot-loop.sh"

WORKDIR="$(mktemp -d /tmp/magpie-m8c2-diag.XXXXXX)"
JOB_DIR="$WORKDIR/job-diag"
UDS_PATH="$JOB_DIR/gw.sock"
LISTENER_LOG="$WORKDIR/host-listener.log"
GUEST_LOG="$WORKDIR/guest.log"
trap 'kill "${LISTENER_PID:-0}" 2>/dev/null || true; rm -rf "$WORKDIR"' EXIT

COUNT=8
python3 "$M8C2_DIR/gw-stub-listener-oneshot-multi.py" "$UDS_PATH" diag "$COUNT" >"$LISTENER_LOG" 2>&1 &
LISTENER_PID=$!
for _ in $(seq 1 50); do
    [ -S "$UDS_PATH" ] && break
    sleep 0.1
done

echo "=== booting micro-VM: $COUNT sequential one-shot /vsock-client dials ===" >&2
set +e
sg kvm -c "'$BIN' --rootfs '$ROOTFS' --exec /bin/sh --arg /m8c2-oneshot-loop.sh --arg 1234 --arg $COUNT \
    --vcpus 2 --ram-mib 512 --uid \$(id -u) --gid \$(id -g) \
    --vsock-port 1234 --vsock-uds '$UDS_PATH'" 2>&1 | tee "$GUEST_LOG"
BOOT_STATUS=${PIPESTATUS[0]}
set -e

echo "=== magpie-krun-launch exited with status $BOOT_STATUS ===" >&2
echo "=== host listener log ===" >&2
cat "$LISTENER_LOG" >&2

ok_count=$(grep -c '^vsock round-trip OK' "$GUEST_LOG" || true)
echo "guest reported $ok_count/$COUNT successful round-trips" >&2
if [ "$ok_count" -eq "$COUNT" ]; then
    echo "PASS: all $COUNT sequential one-shot vsock dials round-tripped successfully" >&2
else
    echo "FAIL: only $ok_count/$COUNT sequential one-shot vsock dials round-tripped" >&2
    exit 1
fi
