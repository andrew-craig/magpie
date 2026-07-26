#!/usr/bin/env bash
# M8-C2 direct-wiring spike -- assertions 3 (multiple connections, sequential
# + parallel) and 4 (half-close propagation both directions).
#
# Boots ONE micro-VM whose guest runs m8c2-driver.sh, which starts the REAL
# magpie-vsock-client relay (rust/target/release/magpie-vsock-client, copied
# in unmodified as /m8c2-relay) and drives 5 sequential + 5 parallel TCP
# round-trips against it from m8c2-relay-client.mjs -- i.e. this exercises
# the actual production guest-side relay code, not a bypass, per the task's
# instruction to prefer driving load through the existing relay.
#
# The host side is gw-stub-listener.py (0711/0666 gateway posture, same as
# assertion 2) configured to accept up to 11 connections (1 preflight dial
# the relay makes on its own startup + 5 seq + 5 par).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPIKE_M8A1_DIR="$REPO_ROOT/spike/m8-a1"
M8C2_DIR="$REPO_ROOT/spike/m8-c2"
BIN="$REPO_ROOT/rust/target/release/magpie-krun-launch"
RELAY_BIN="$REPO_ROOT/rust/target/release/magpie-vsock-client"
ROOTFS="$SPIKE_M8A1_DIR/rootfs"

if [ ! -x "$BIN" ] || [ ! -x "$RELAY_BIN" ]; then
    echo "building release binaries..." >&2
    (cd "$REPO_ROOT/rust" && cargo build --release -p magpie-microvm-launcher -p magpie-vsock-client)
fi
if [ ! -d "$ROOTFS" ]; then
    echo "missing $ROOTFS -- see spike/m8-a1/provision.sh" >&2
    exit 1
fi

# Install the real relay + our node driver into the (gitignored, regenerable)
# m8-a1 rootfs at runtime -- same pattern smoke-test.sh uses for
# smoke-probe.sh. Named /m8c2-relay (NOT /vsock-client) so it never collides
# with the m8-a1 one-shot binary the baseline smoke test depends on.
install -m 0755 "$RELAY_BIN" "$ROOTFS/m8c2-relay"
install -m 0644 "$M8C2_DIR/m8c2-relay-client.mjs" "$ROOTFS/m8c2-relay-client.mjs"
install -m 0755 "$M8C2_DIR/m8c2-driver.sh" "$ROOTFS/m8c2-driver.sh"

WORKDIR="$(mktemp -d /tmp/magpie-m8c2-multi.XXXXXX)"
JOB_DIR="$WORKDIR/job-multi"
UDS_PATH="$JOB_DIR/gw.sock"
LISTENER_LOG="$WORKDIR/host-listener.log"
GUEST_LOG="$WORKDIR/guest.log"
trap 'kill "${LISTENER_PID:-0}" 2>/dev/null || true; rm -rf "$WORKDIR"' EXIT

# Budget: 1 relay startup preflight dial (rust/vsock-client's
# connect_with_retry, immediately dropped) + 1 dial from THIS script's own
# "wait for relay TCP" readiness probe (an empty TCP connection that the
# relay itself still faithfully relays as a fresh, empty vsock connection)
# + 5 seq + 5 par = 12. Learned the hard way: an earlier version of this
# script capped the listener at exactly 11 and the last parallel
# connection (par-4) got an empty reply because the listener had already
# hit its cap and stopped accepting by the time it dialed -- a test-harness
# accounting bug, not a wiring failure (see direct-wiring-spike.md). Padded
# to 20 for headroom.
echo "=== starting gw-stub-listener (max 15 connections) uds=$UDS_PATH ===" >&2
python3 "$M8C2_DIR/gw-stub-listener.py" "$UDS_PATH" multi 15 10 >"$LISTENER_LOG" 2>&1 &
LISTENER_PID=$!
for _ in $(seq 1 50); do
    [ -S "$UDS_PATH" ] && break
    sleep 0.1
done
if [ ! -S "$UDS_PATH" ]; then
    echo "host listener never bound $UDS_PATH -- see $LISTENER_LOG" >&2
    exit 1
fi

echo "=== booting micro-VM (rootfs=$ROOTFS) ===" >&2
set +e
sg kvm -c "'$BIN' --rootfs '$ROOTFS' --exec /bin/sh --arg /m8c2-driver.sh --arg 1234 --arg both --arg 5 --arg vmA \
    --vcpus 2 --ram-mib 512 --uid \$(id -u) --gid \$(id -g) \
    --vsock-port 1234 --vsock-uds '$UDS_PATH'" 2>&1 | tee "$GUEST_LOG"
BOOT_STATUS=${PIPESTATUS[0]}
set -e

echo "=== magpie-krun-launch exited with status $BOOT_STATUS ===" >&2
echo "=== host listener log ===" >&2
cat "$LISTENER_LOG" >&2

FAIL=0

seq_count=$(grep -c '^M8C2-SEQ ' "$GUEST_LOG" || true)
par_count=$(grep -c '^M8C2-PAR ' "$GUEST_LOG" || true)
echo "guest reported seq_count=$seq_count par_count=$par_count" >&2
[ "$seq_count" -eq 5 ] && echo "PASS: 5/5 sequential round-trips completed" >&2 \
    || { echo "FAIL: expected 5 sequential round-trips, got $seq_count" >&2; FAIL=1; }
[ "$par_count" -eq 5 ] && echo "PASS: 5/5 parallel round-trips completed" >&2 \
    || { echo "FAIL: expected 5 parallel round-trips, got $par_count" >&2; FAIL=1; }

# Every M8C2-SEQ/M8C2-PAR line the guest printed must show saw_host_eof=true
# (assertion 4, host->guest direction) and a reply containing this
# connection's own label, distinct from every other connection's (proves
# the relay dialed a FRESH vsock connection per TCP connection and the host
# demuxed correctly instead of e.g. serializing/interleaving replies).
bad_eof=$(grep -E '^M8C2-(SEQ|PAR) ' "$GUEST_LOG" | grep -cv 'saw_host_eof=true' || true)
[ "$bad_eof" -eq 0 ] && echo "PASS: every connection observed host->guest half-close (saw_host_eof=true)" >&2 \
    || { echo "FAIL: $bad_eof connection(s) did not see host EOF" >&2; FAIL=1; }

mismatched=0
while IFS= read -r line; do
    label=$(echo "$line" | grep -oE 'label=[^ ]+' | cut -d= -f2)
    if ! echo "$line" | grep -qF "reply=\"ACK[multi]:MSG from $label"; then
        mismatched=$((mismatched + 1))
        echo "MISMATCH: $line" >&2
    fi
done < <(grep -E '^M8C2-(SEQ|PAR) ' "$GUEST_LOG")
[ "$mismatched" -eq 0 ] && echo "PASS: every connection's reply echoed exactly its own label (no cross-talk/misrouting)" >&2 \
    || { echo "FAIL: $mismatched connection(s) got a mismatched reply" >&2; FAIL=1; }

host_eof_from_guest=$(grep -c 'half-close observed' "$LISTENER_LOG" || true)
echo "host observed guest->host EOF on $host_eof_from_guest connection(s)" >&2
[ "$host_eof_from_guest" -ge 10 ] && echo "PASS: host observed guest->host half-close on all connections" >&2 \
    || { echo "FAIL: expected >=10 guest->host half-closes, saw $host_eof_from_guest" >&2; FAIL=1; }

if [ "$FAIL" -ne 0 ]; then
    echo "one or more assertions FAILED" >&2
    exit 1
fi
echo "ALL ASSERTION-3/4 CHECKS PASSED" >&2
