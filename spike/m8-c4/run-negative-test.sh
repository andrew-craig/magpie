#!/usr/bin/env bash
# spike/m8-c4/run-negative-test.sh -- task_3b48 (M8-C4) acceptance-crux
# negative test, run live on real hardware:
#
#   sg kvm -c 'spike/m8-c4/run-negative-test.sh'
#
# "No network by construction" is a THREE-layer invariant (see
# docker/reviewer/entrypoint.sh's and rust/magpie-microvm-launcher/src/
# krun.rs's own doc comments). Layers 1 (construction) and 2 (launch
# preflight) cannot be exercised by a mis-launch, by definition -- they ARE
# the thing that prevents one in the real launcher. This script proves
# Layer 3 (docker/reviewer/entrypoint.sh's in-guest fail-closed assertion)
# actually catches a TSI-hijack mis-launch that bypasses Layers 1/2 entirely
# (via the wholly separate, TEST-ONLY tsi-hijack-launch.c harness in this
# directory -- NOT the production magpie-krun-launch, which has no way to
# do this).
#
# Two phases:
#
#   PHASE 1 (diag-probe.sh, bypassing entrypoint.sh entirely): boots the
#   TEST-ONLY harness directly against a bare probe script, to independently
#   confirm what TSI hijack ACTUALLY DOES on this box's installed libkrun
#   (v1.19.4) before trusting entrypoint.sh's own verdict on it. Empirically
#   established (this task):
#     - TSI OFF : dummy0 present but operstate=down, 0 IPv4 routes, raw
#       connect() to 1.1.1.1:443 blocked ("Network is unreachable").
#     - TSI ON  : dummy0 operstate=unknown (up), a REAL IPv4 route appears
#       (libkrun's TSI-INET hijack DHCP-configures it), and the raw
#       connect() to 1.1.1.1:443 SUCCEEDS FOR REAL (this host has genuine
#       internet egress, so this is not a false positive -- see the task
#       file's plan section). This independently proves (a) the mis-launch
#       harness genuinely reproduces a hijacked guest, not just a flag, and
#       (b) the active-egress-canary MECHANISM entrypoint.sh also uses is
#       sound on its own terms, decoupled from whichever Layer-3 check
#       happens to fire first in the full run below.
#
#   PHASE 2 (the real docker/reviewer/entrypoint.sh, refreshed from source):
#   boots the SAME rootfs (spike/m8-a1's already-exported reviewer image)
#   with --exec pointed at the actual, current entrypoint.sh, twice:
#     1. POSITIVE control (TSI off) -- expect it to reach and log "network
#        confinement verified".
#     2. NEGATIVE (TSI on) -- expect it to ABORT somewhere in the Layer-3
#        block and NEVER log "network confinement verified". On THIS
#        specific libkrun version the interface-operstate check (2a) is
#        what fires first (dummy0 goes non-down under hijack -- see PHASE 1)
#        rather than the active-egress canary; that is still a genuine,
#        correct Layer-3 catch (defense-in-depth working as intended, not a
#        weaker result), and PHASE 1 already independently proves the
#        canary mechanism itself would ALSO have caught this had the
#        interface check not fired first (e.g. on a hypothetical libkrun
#        build where TSI hijacking left no interface-level trace at all).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPIKE_C4_DIR="$REPO_ROOT/spike/m8-c4"
SPIKE_A1_DIR="$REPO_ROOT/spike/m8-a1"
ROOTFS="$SPIKE_A1_DIR/rootfs"
HARNESS_BIN="$SPIKE_C4_DIR/tsi-hijack-launch"
VSOCK_CLIENT_BUILD="$REPO_ROOT/rust/target/release/magpie-vsock-client"

if [ ! -d "$ROOTFS" ]; then
  echo "missing $ROOTFS -- this test reuses the M8-A1 spike's already-exported reviewer rootfs (see rust/magpie-microvm-launcher/smoke-test.sh's own note); provision.sh regenerates it." >&2
  exit 1
fi

echo "=== building tsi-hijack-launch.c (TEST-ONLY harness) ===" >&2
gcc -O2 -o "$HARNESS_BIN" "$SPIKE_C4_DIR/tsi-hijack-launch.c" -I/usr/local/include -L/usr/local/lib64 -lkrun

echo "=== building rust/vsock-client (release) ===" >&2
(cd "$REPO_ROOT/rust" && cargo build --release -p magpie-vsock-client >&2)

echo "=== refreshing rootfs with CURRENT entrypoint.sh + vsock-client + diag-probe.sh ===" >&2
# IMPORTANT: only ever touch $ROOTFS/opt/magpie/vsock-client here -- that is
# the ONLY path docker/reviewer/entrypoint.sh actually execs
# (rust/vsock-client's `magpie-vsock-client`, the TCP<->AF_VSOCK relay).
# $ROOTFS/vsock-client (no /opt/magpie prefix) is a DIFFERENT program --
# spike/m8-a1/vsock-client's one-shot PING/PONG round-trip client, which
# rust/magpie-microvm-launcher/smoke-test.sh's smoke-probe.sh depends on
# unchanged. An earlier version of this script clobbered that path with the
# relay binary, which silently broke smoke-test.sh (the relay just listens
# forever on 127.0.0.1:4000 and never sends the PING smoke-probe.sh expects,
# so the round-trip assertion timed out) since the shared, gitignored
# spike/m8-a1/rootfs/ directory is a fixture multiple scripts depend on with
# DIFFERENT expectations for that filename -- never write it from here.
install -m 0755 "$REPO_ROOT/docker/reviewer/entrypoint.sh" "$ROOTFS/opt/magpie/entrypoint.sh"
install -m 0755 "$VSOCK_CLIENT_BUILD" "$ROOTFS/opt/magpie/vsock-client"
install -m 0755 "$SPIKE_C4_DIR/diag-probe.sh" "$ROOTFS/diag-probe.sh"

WORKDIR="$(mktemp -d /tmp/magpie-c4-negtest.XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

WORK_HOST_DIR="$WORKDIR/work"
OUT_HOST_DIR="$WORKDIR/out"
mkdir -p "$WORK_HOST_DIR" "$OUT_HOST_DIR"
echo 'console.log("hello from m8-c4 negative test fixture");' > "$WORK_HOST_DIR/sample.js"

UDS_PATH="$WORKDIR/gw.sock"
LISTENER_LOG="$WORKDIR/gw-listener.log"

FAIL=0

start_listener() {
  python3 "$SPIKE_C4_DIR/gw-stub-listener.py" "$UDS_PATH" >"$LISTENER_LOG" 2>&1 &
  LISTENER_PID=$!
  for _ in $(seq 1 50); do
    [ -S "$UDS_PATH" ] && return 0
    sleep 0.1
  done
  echo "gw-stub-listener never bound $UDS_PATH -- see $LISTENER_LOG" >&2
  return 1
}

stop_listener() {
  kill "${LISTENER_PID:-0}" 2>/dev/null || true
  wait "${LISTENER_PID:-0}" 2>/dev/null || true
  rm -f "$UDS_PATH"
}

assert() {
  local desc="$1" cond="$2"
  if eval "$cond"; then
    echo "PASS: $desc" >&2
  else
    echo "FAIL: $desc" >&2
    FAIL=1
  fi
}

# --- PHASE 1: bare diag-probe.sh, bypassing entrypoint.sh entirely ---------
run_diag() {
  local tsi_features="$1" guest_log="$2"
  set +e
  sg kvm -c "
    export MAGPIE_ROOTFS='$ROOTFS'
    export MAGPIE_EXEC='/diag-probe.sh'
    export MAGPIE_UID=\$(id -u)
    export MAGPIE_GID=\$(id -g)
    export MAGPIE_VCPUS=2
    export MAGPIE_RAM_MIB=768
    export MAGPIE_TSI_FEATURES='$tsi_features'
    timeout 15 '$HARNESS_BIN'
  " >"$guest_log" 2>&1
  local status=$?
  set -e
  echo "=== diag boot (tsi_features=$tsi_features) exited with status $status; log: $guest_log ===" >&2
}

DIAG_OFF_LOG="$WORKDIR/diag-off.log"
DIAG_ON_LOG="$WORKDIR/diag-on.log"

echo "" >&2
echo "=== PHASE 1a: diag-probe, MAGPIE_TSI_FEATURES=0 (TSI off) ===" >&2
run_diag 0 "$DIAG_OFF_LOG"
cat "$DIAG_OFF_LOG" >&2

echo "" >&2
echo "=== PHASE 1b: diag-probe, MAGPIE_TSI_FEATURES=1 (KRUN_TSI_HIJACK_INET) ===" >&2
run_diag 1 "$DIAG_ON_LOG"
cat "$DIAG_ON_LOG" >&2

assert "diag(TSI off): dummy0 is administratively down" \
  "grep -qE 'dummy0 operstate: down' '$DIAG_OFF_LOG'"
assert "diag(TSI off): IPv4 route table is empty (no dummy0 route line)" \
  "! grep -qE '^dummy0\s' '$DIAG_OFF_LOG'"
assert "diag(TSI off): raw egress connect() to 1.1.1.1:443 is blocked" \
  "grep -qF 'egress-blocked-good' '$DIAG_OFF_LOG'"

assert "diag(TSI on): dummy0 is NOT administratively down (hijack changed its state)" \
  "! grep -qE 'dummy0 operstate: down' '$DIAG_ON_LOG'"
assert "diag(TSI on): a REAL IPv4 route now exists via dummy0" \
  "grep -qE '^dummy0\s' '$DIAG_ON_LOG'"
assert "diag(TSI on): raw egress connect() to 1.1.1.1:443 SUCCEEDS (proves the mis-launch is real, and that an egress-canary mechanism independently catches it)" \
  "grep -qF 'EGRESS-REACHABLE-BAD' '$DIAG_ON_LOG'"

# --- PHASE 2: the real, current docker/reviewer/entrypoint.sh --------------
run_boot() {
  local tsi_features="$1" guest_log="$2"
  start_listener

  set +e
  sg kvm -c "
    export MAGPIE_ROOTFS='$ROOTFS'
    export MAGPIE_EXEC='/opt/magpie/entrypoint.sh'
    export MAGPIE_UID=\$(id -u)
    export MAGPIE_GID=\$(id -g)
    export MAGPIE_VCPUS=2
    export MAGPIE_RAM_MIB=768
    export MAGPIE_WORK_MOUNT_HOST='$WORK_HOST_DIR:work'
    export MAGPIE_OUT_MOUNT_HOST='$OUT_HOST_DIR:out'
    export MAGPIE_VSOCK_PORT=1234
    export MAGPIE_VSOCK_UDS='$UDS_PATH'
    export MAGPIE_TSI_FEATURES='$tsi_features'
    export OPENROUTER_API_KEY='sk-magpie-m8c4-negativetest'
    export OPENAI_BASE_URL='http://127.0.0.1:4000/v1'
    export MAGPIE_REQUIRE_MEMORY_LIMIT=false
    timeout 20 '$HARNESS_BIN' --provider openrouter --model m8-c4/negative-test
  " >"$guest_log" 2>&1
  local status=$?
  set -e

  stop_listener
  echo "=== boot (tsi_features=$tsi_features) exited with status $status; log: $guest_log ===" >&2
}

POSITIVE_LOG="$WORKDIR/positive.log"
NEGATIVE_LOG="$WORKDIR/negative.log"

echo "" >&2
echo "=== PHASE 2a: entrypoint.sh, MAGPIE_TSI_FEATURES=0 (TSI off, production posture) ===" >&2
run_boot 0 "$POSITIVE_LOG"
cat "$POSITIVE_LOG" >&2

echo "" >&2
echo "=== PHASE 2b: entrypoint.sh, MAGPIE_TSI_FEATURES=1 (KRUN_TSI_HIJACK_INET mis-launch) ===" >&2
run_boot 1 "$NEGATIVE_LOG"
cat "$NEGATIVE_LOG" >&2

assert "positive boot logs 'network confinement verified'" \
  "grep -qF 'network confinement verified' '$POSITIVE_LOG'"
assert "positive boot does NOT abort on any Layer-3 check" \
  "! grep -qE 'refusing to run: (non-loopback|IPv4 route table|IPv6 route table|network canary|/dev/vsock is missing|own MAGPIE_VSOCK_PORT)' '$POSITIVE_LOG'"

assert "negative boot does NOT reach 'network confinement verified'" \
  "! grep -qF 'network confinement verified' '$NEGATIVE_LOG'"
assert "negative boot IS aborted by a Layer-3 confinement check (defense-in-depth -- any of interface/route/canary is an acceptable, correct catch)" \
  "grep -qE 'refusing to run: (non-loopback|IPv4 route table|IPv6 route table|network canary)' '$NEGATIVE_LOG'"

echo "" >&2
if [ "$FAIL" -ne 0 ]; then
  echo "one or more assertions FAILED -- see output above" >&2
  exit 1
fi
echo "ALL ASSERTIONS PASSED -- Layer 3 catches a TSI-hijack mis-launch that Layers 1/2 cannot, and the active-egress-canary mechanism is independently proven sound" >&2
