#!/usr/bin/env bash
# Diagnostic: single connection through the real relay, with the
# instrumented m8c2-relay-client-debug.mjs, to see exactly which socket
# events fire (and when) for the empty-reply anomaly.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPIKE_M8A1_DIR="$REPO_ROOT/spike/m8-a1"
M8C2_DIR="$REPO_ROOT/spike/m8-c2"
BIN="$REPO_ROOT/rust/target/release/magpie-krun-launch"
RELAY_BIN="$REPO_ROOT/rust/target/release/magpie-vsock-client"
ROOTFS="$SPIKE_M8A1_DIR/rootfs"

install -m 0755 "$RELAY_BIN" "$ROOTFS/m8c2-relay"
install -m 0644 "$M8C2_DIR/m8c2-relay-client-debug.mjs" "$ROOTFS/m8c2-relay-client-debug.mjs"

WORKDIR="$(mktemp -d /tmp/magpie-m8c2-relaydbg.XXXXXX)"
JOB_DIR="$WORKDIR/job-dbg"
UDS_PATH="$JOB_DIR/gw.sock"
LISTENER_LOG="$WORKDIR/host-listener.log"
GUEST_LOG="$WORKDIR/guest.log"
trap 'kill "${LISTENER_PID:-0}" 2>/dev/null || true; rm -rf "$WORKDIR"' EXIT

python3 "$M8C2_DIR/gw-stub-listener.py" "$UDS_PATH" dbg 5 15 >"$LISTENER_LOG" 2>&1 &
LISTENER_PID=$!
for _ in $(seq 1 50); do
    [ -S "$UDS_PATH" ] && break
    sleep 0.1
done

GUEST_SCRIPT='
MAGPIE_VSOCK_PORT=1234 /m8c2-relay >/tmp/relay.log 2>&1 &
i=0
until node -e "require(\"net\").connect({host:\"127.0.0.1\",port:4000},()=>process.exit(0)).on(\"error\",()=>process.exit(1))" 2>/dev/null; do
  i=$((i+1)); [ "$i" -ge 50 ] && { cat /tmp/relay.log; exit 1; }; sleep 0.1
done
echo "=== attempt 1 ==="
node /m8c2-relay-client-debug.mjs conn1
echo "=== attempt 2 ==="
node /m8c2-relay-client-debug.mjs conn2
echo "=== attempt 3 ==="
node /m8c2-relay-client-debug.mjs conn3
echo "=== relay log ==="
cat /tmp/relay.log
'
echo "$GUEST_SCRIPT" > "$ROOTFS/m8c2-diag.sh"
chmod +x "$ROOTFS/m8c2-diag.sh"

echo "=== booting micro-VM ===" >&2
set +e
sg kvm -c "'$BIN' --rootfs '$ROOTFS' --exec /bin/sh --arg /m8c2-diag.sh \
    --vcpus 2 --ram-mib 512 --uid \$(id -u) --gid \$(id -g) \
    --vsock-port 1234 --vsock-uds '$UDS_PATH'" 2>&1 | tee "$GUEST_LOG"
set -e

echo "=== host listener log ===" >&2
cat "$LISTENER_LOG" >&2
