#!/usr/bin/env bash
# M8-C2 direct-wiring spike -- assertion 2: "gateway-permissions variant".
#
# Reuses the exact same one-shot guest probe as
# rust/magpie-microvm-launcher/smoke-test.sh (the m8-a1 spike's prebuilt
# /vsock-client, already baked into spike/m8-a1/rootfs) but points
# --vsock-uds at a host listener bound with the REAL gateway's exact
# permission posture: job directory mode 0711, socket file mode 0666,
# chmod'd explicitly AFTER listen() -- see
# packages/gateway/src/job-sockets.ts (JOB_DIR_MODE / SOCKET_FILE_MODE).
#
# This does NOT edit smoke-test.sh or any m8-a1 file; it is a new sibling
# script under spike/m8-c2/ using the new spike/m8-c2/gw-stub-listener.py.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPIKE_M8A1_DIR="$REPO_ROOT/spike/m8-a1"
M8C2_DIR="$REPO_ROOT/spike/m8-c2"
BIN="$REPO_ROOT/rust/target/release/magpie-krun-launch"
ROOTFS="$SPIKE_M8A1_DIR/rootfs"

if [ ! -x "$BIN" ]; then
    echo "building release binary..." >&2
    (cd "$REPO_ROOT/rust" && cargo build -p magpie-microvm-launcher --release)
fi
if [ ! -d "$ROOTFS" ]; then
    echo "missing $ROOTFS -- see spike/m8-a1/provision.sh" >&2
    exit 1
fi

WORKDIR="$(mktemp -d /tmp/magpie-m8c2-gwperms.XXXXXX)"
# One extra path component vs. the baseline smoke test's $WORKDIR/gw.sock:
# job-sockets.ts's real layout is <socketDirRoot 0700>/<jobId 0711>/gw.sock,
# so nest a "job dir" under our own 0700 mktemp root to mirror that shape
# (gw-stub-listener.py chmod's the job dir 0711 itself; it does not touch
# $WORKDIR).
JOB_DIR="$WORKDIR/job-abc123"
UDS_PATH="$JOB_DIR/gw.sock"
LISTENER_LOG="$WORKDIR/host-listener.log"
GUEST_LOG="$WORKDIR/guest.log"
trap 'kill "${LISTENER_PID:-0}" 2>/dev/null || true; rm -rf "$WORKDIR"' EXIT

echo "=== starting gw-stub-listener-oneshot (gateway perms posture) uds=$UDS_PATH ===" >&2
python3 "$M8C2_DIR/gw-stub-listener-oneshot.py" "$UDS_PATH" gwperms >"$LISTENER_LOG" 2>&1 &
LISTENER_PID=$!
for _ in $(seq 1 50); do
    [ -S "$UDS_PATH" ] && break
    sleep 0.1
done
if [ ! -S "$UDS_PATH" ]; then
    echo "host listener never bound $UDS_PATH -- see $LISTENER_LOG" >&2
    exit 1
fi

PERMS_LOG="$WORKDIR/perms.log"
echo "=== permission check (host side, before guest boots) ===" >&2
# Written to its OWN file, not $LISTENER_LOG: the listener is a separate
# live process concurrently appending to $LISTENER_LOG, and interleaving
# writes from two independent processes into one file without coordination
# can garble lines (observed empirically) -- purely a test-harness logging
# hazard, unrelated to the vsock mechanics under test.
stat -c 'job_dir %a %n' "$JOB_DIR" | tee "$PERMS_LOG" >&2
stat -c 'socket   %a %n' "$UDS_PATH" | tee -a "$PERMS_LOG" >&2

echo "=== booting micro-VM (rootfs=$ROOTFS) ===" >&2
set +e
sg kvm -c "'$BIN' --rootfs '$ROOTFS' --exec /vsock-client --arg 1234 \
    --vcpus 2 --ram-mib 512 --uid \$(id -u) --gid \$(id -g) \
    --vsock-port 1234 --vsock-uds '$UDS_PATH'" 2>&1 | tee "$GUEST_LOG"
BOOT_STATUS=${PIPESTATUS[0]}
set -e

echo "=== magpie-krun-launch exited with status $BOOT_STATUS ===" >&2
echo "=== host listener log ===" >&2
cat "$LISTENER_LOG" >&2

FAIL=0
if grep -qF "vsock round-trip OK" "$GUEST_LOG"; then
    echo "PASS: guest completed vsock round-trip against 0711/0666 host socket" >&2
else
    echo "FAIL: guest did not report a successful vsock round-trip" >&2
    FAIL=1
fi
if grep -qF "job_dir 711" "$PERMS_LOG"; then
    echo "PASS: job directory really is mode 0711" >&2
else
    echo "FAIL: job directory mode assertion did not match 0711" >&2
    FAIL=1
fi
if grep -qF "socket   666" "$PERMS_LOG"; then
    echo "PASS: socket file really is mode 0666" >&2
else
    echo "FAIL: socket file mode assertion did not match 0666" >&2
    FAIL=1
fi
if grep -qF "received b'PING from rust guest" "$LISTENER_LOG"; then
    echo "PASS: host listener actually received the guest's vsock PING through the 0711/0666 posture" >&2
else
    echo "FAIL: host listener log missing the guest's PING" >&2
    FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
    echo "one or more assertions FAILED" >&2
    exit 1
fi
echo "ALL ASSERTION-2 CHECKS PASSED" >&2
