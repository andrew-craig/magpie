#!/usr/bin/env bash
# M8-C2 direct-wiring spike -- assertion 5: per-job isolation.
#
# Boots TWO micro-VMs CONCURRENTLY, each with its own uds_path/gw.sock (own
# directory entirely, own gw-stub-listener-oneshot process), and confirms
# VM A's connection only ever reaches listener A and VM B's only ever
# reaches listener B.
#
# Uses the RAW one-shot /vsock-client (proven reliable: run-diag-oneshot-
# loop.sh, 24/24 sequential; run-diag-parallel-oneshot.sh, 15/15 parallel)
# rather than the magpie-vsock-client relay: direct-wiring-spike.md
# documents a reproducible early-connection data-loss defect in that relay
# under back-to-back TCP proxy load, which is orthogonal to (and would only
# muddy) what THIS assertion is actually testing -- whether two
# independent uds_paths cross-talk. Isolation is verified by ACCEPT COUNT
# per listener (exactly 1 each, never 0 or 2): the one-shot client's
# payload text is a fixed constant, so a cross-connection would show up as
# one listener accepting twice and the other timing out with zero, not as
# different payload content.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPIKE_M8A1_DIR="$REPO_ROOT/spike/m8-a1"
M8C2_DIR="$REPO_ROOT/spike/m8-c2"
BIN="$REPO_ROOT/rust/target/release/magpie-krun-launch"
ROOTFS="$SPIKE_M8A1_DIR/rootfs"

WORKDIR="$(mktemp -d /tmp/magpie-m8c2-iso.XXXXXX)"
JOB_DIR_A="$WORKDIR/job-A"
JOB_DIR_B="$WORKDIR/job-B"
UDS_A="$JOB_DIR_A/gw.sock"
UDS_B="$JOB_DIR_B/gw.sock"
LOG_A="$WORKDIR/host-listener-A.log"
LOG_B="$WORKDIR/host-listener-B.log"
GUEST_LOG_A="$WORKDIR/guest-A.log"
GUEST_LOG_B="$WORKDIR/guest-B.log"
trap 'kill "${LISTENER_A_PID:-0}" "${LISTENER_B_PID:-0}" 2>/dev/null || true; rm -rf "$WORKDIR"' EXIT

echo "=== starting two independent gw-stub-listener-oneshot-multi processes (count=1 each) ===" >&2
python3 "$M8C2_DIR/gw-stub-listener-oneshot-multi.py" "$UDS_A" vmA 1 >"$LOG_A" 2>&1 &
LISTENER_A_PID=$!
python3 "$M8C2_DIR/gw-stub-listener-oneshot-multi.py" "$UDS_B" vmB 1 >"$LOG_B" 2>&1 &
LISTENER_B_PID=$!
for _ in $(seq 1 50); do
    [ -S "$UDS_A" ] && [ -S "$UDS_B" ] && break
    sleep 0.1
done
if [ ! -S "$UDS_A" ] || [ ! -S "$UDS_B" ]; then
    echo "one or both host listeners never bound -- see $LOG_A / $LOG_B" >&2
    exit 1
fi

echo "=== booting TWO micro-VMs concurrently (rootfs=$ROOTFS) ===" >&2
set +e
sg kvm -c "'$BIN' --rootfs '$ROOTFS' --exec /vsock-client --arg 1234 \
    --vcpus 1 --ram-mib 384 --uid \$(id -u) --gid \$(id -g) \
    --vsock-port 1234 --vsock-uds '$UDS_A'" >"$GUEST_LOG_A" 2>&1 &
VM_A_PID=$!
sg kvm -c "'$BIN' --rootfs '$ROOTFS' --exec /vsock-client --arg 1234 \
    --vcpus 1 --ram-mib 384 --uid \$(id -u) --gid \$(id -g) \
    --vsock-port 1234 --vsock-uds '$UDS_B'" >"$GUEST_LOG_B" 2>&1 &
VM_B_PID=$!

wait "$VM_A_PID"; STATUS_A=$?
wait "$VM_B_PID"; STATUS_B=$?
set -e

echo "=== VM A exited with status $STATUS_A; VM B exited with status $STATUS_B ===" >&2
echo "--- guest A log ---" >&2; cat "$GUEST_LOG_A" >&2
echo "--- guest B log ---" >&2; cat "$GUEST_LOG_B" >&2
echo "--- host listener A log ---" >&2; cat "$LOG_A" >&2
echo "--- host listener B log ---" >&2; cat "$LOG_B" >&2

FAIL=0

grep -qF "vsock round-trip OK" "$GUEST_LOG_A" \
    && echo "PASS: VM A's guest completed its round-trip" >&2 \
    || { echo "FAIL: VM A's guest did not complete its round-trip" >&2; FAIL=1; }
grep -qF "vsock round-trip OK" "$GUEST_LOG_B" \
    && echo "PASS: VM B's guest completed its round-trip" >&2 \
    || { echo "FAIL: VM B's guest did not complete its round-trip" >&2; FAIL=1; }

# The crux: each listener must show EXACTLY ONE accept (its own VM's), never
# zero (its VM's traffic went missing/elsewhere) and never two (it also
# received the OTHER VM's connection -- a cross-job leak).
count_a=$(grep -c 'received' "$LOG_A" || true)
count_b=$(grep -c 'received' "$LOG_B" || true)
echo "listener A accepted $count_a connection(s); listener B accepted $count_b connection(s)" >&2
[ "$count_a" -eq 1 ] && echo "PASS: listener A (VM A's own socket) received EXACTLY one connection" >&2 \
    || { echo "FAIL: listener A received $count_a connections (expected exactly 1) -- possible cross-job leak or lost connection" >&2; FAIL=1; }
[ "$count_b" -eq 1 ] && echo "PASS: listener B (VM B's own socket) received EXACTLY one connection" >&2 \
    || { echo "FAIL: listener B received $count_b connections (expected exactly 1) -- possible cross-job leak or lost connection" >&2; FAIL=1; }

if [ "$FAIL" -ne 0 ]; then
    echo "one or more assertions FAILED" >&2
    exit 1
fi
echo "ALL ASSERTION-5 (ISOLATION) CHECKS PASSED" >&2
