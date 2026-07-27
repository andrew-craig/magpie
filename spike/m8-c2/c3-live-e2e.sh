#!/usr/bin/env bash
# M8-C3 (task_39ff) LIVE micro-VM end-to-end test on real /dev/kvm + libkrun.
#
# NOT part of `cargo test`/`npm test` -- boots a real micro-VM via
# magpie-krun-launch, same hardware requirements as
# rust/magpie-microvm-launcher/smoke-test.sh. Run:
#
#   sg kvm -c 'spike/m8-c2/c3-live-e2e.sh'
#
# Proves the three NEW C3 mechanics end-to-end against real hardware:
#   1. --out-mount (writable virtiofs): the guest writes findings.json, it
#      lands host-side.
#   2. --env-from-host: a value passed by NAME reaches the guest env, and is
#      NEVER on the launcher argv (checked here too).
#   3. A GATEWAY-SHAPED HTTP round-trip over --vsock-uds through the REAL
#      libkrun vsock bridge (the bug_73b2 transport), with a review-shaped
#      reply of a KNOWN size, asserting ZERO byte loss.
#
# Reuses spike/m8-a1/rootfs (the exported reviewer rootfs) and the freshly
# built magpie-vsock-client relay + magpie-krun-launch launcher.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPIKE_C2="$REPO_ROOT/spike/m8-c2"
ROOTFS="$REPO_ROOT/spike/m8-a1/rootfs"
WORK_HOST_DIR="$REPO_ROOT/spike/m8-a1/work-fixture"
BIN="$REPO_ROOT/rust/target/release/magpie-krun-launch"
RELAY="$REPO_ROOT/rust/target/release/magpie-vsock-client"
RESP_BYTES=200000

for f in "$BIN" "$RELAY"; do
  if [ ! -x "$f" ]; then
    echo "building rust release binaries..." >&2
    (cd "$REPO_ROOT/rust" && cargo build --release -p magpie-microvm-launcher -p magpie-vsock-client)
    break
  fi
done
[ -d "$ROOTFS" ] || { echo "missing $ROOTFS (see spike/m8-a1/provision.sh)" >&2; exit 1; }

WORKDIR="$(mktemp -d /tmp/magpie-c3-e2e.XXXXXX)"
UDS_PATH="$WORKDIR/gw.sock"
OUT_HOST_DIR="$WORKDIR/out"
GW_LOG="$WORKDIR/gw.log"
GUEST_LOG="$WORKDIR/guest.log"
mkdir -p "$OUT_HOST_DIR"
trap 'kill "${GW_PID:-0}" 2>/dev/null || true; rm -rf "$WORKDIR"' EXIT

# Install the fresh relay into the rootfs slot entrypoint.sh uses, and the
# guest probe as the --exec target (mirrors smoke-test.sh's install of
# smoke-probe.sh -- the rootfs is gitignored/regenerable, so scripts live
# outside it and are copied in at run time).
install -m 0755 "$RELAY" "$ROOTFS/opt/magpie/vsock-client"
install -m 0755 "$SPIKE_C2/c3-guest-probe.sh" "$ROOTFS/c3-guest-probe.sh"

echo "=== starting host gateway-shaped listener (uds=$UDS_PATH) ===" >&2
node "$SPIKE_C2/c3-gw-listener.mjs" "$UDS_PATH" "$RESP_BYTES" >"$GW_LOG" 2>&1 &
GW_PID=$!
for _ in $(seq 1 50); do [ -S "$UDS_PATH" ] && break; sleep 0.1; done
[ -S "$UDS_PATH" ] || { echo "gateway listener never bound $UDS_PATH -- see $GW_LOG" >&2; cat "$GW_LOG" >&2; exit 1; }

echo "=== booting micro-VM (out-mount + vsock + env-from-host) ===" >&2
set +e
# MAGPIE_FAKE_KEY is set in the launcher's OWN env (inline before the binary),
# so `--env-from-host MAGPIE_FAKE_KEY` forwards its VALUE into the guest
# WITHOUT it ever appearing on the launcher argv -- exactly reviewer.ts's
# uid-split convention. --uid/--gid resolved INSIDE the sg subshell (see
# smoke-test.sh's note on the sg-kvm gid wrinkle).
sg kvm -c "MAGPIE_FAKE_KEY=sk-magpie-live-e2e-secret '$BIN' \
    --rootfs '$ROOTFS' --exec /c3-guest-probe.sh \
    --vcpus 2 --ram-mib 512 --uid \$(id -u) --gid \$(id -g) \
    --vsock-port 1234 --vsock-uds '$UDS_PATH' \
    --work-mount '$WORK_HOST_DIR:work' \
    --out-mount '$OUT_HOST_DIR:out' \
    --env-from-host MAGPIE_FAKE_KEY" 2>&1 | tee "$GUEST_LOG"
BOOT_STATUS=${PIPESTATUS[0]}
set -e

echo "" >&2
echo "=== magpie-krun-launch exited with status $BOOT_STATUS ===" >&2
echo "=== host gateway listener log ===" >&2
cat "$GW_LOG" >&2

echo "" >&2
echo "=== automated assertions ===" >&2
FAIL=0
pass() { echo "PASS: $1" >&2; }
fail() { echo "FAIL: $1" >&2; FAIL=1; }

# 1. --out-mount writable: findings.json the GUEST wrote is visible HOST-side.
if [ -f "$OUT_HOST_DIR/findings.json" ] && grep -q '"summary":"live-e2e"' "$OUT_HOST_DIR/findings.json"; then
  pass "--out-mount writable: guest-written findings.json landed host-side"
else
  fail "--out-mount: findings.json not found host-side at $OUT_HOST_DIR/findings.json"
fi
grep -qF "out-write-ok:" "$GUEST_LOG" && pass "guest reported /out mount + write ok" || fail "guest did not report /out write ok"

# 2. --env-from-host: value reached the guest env, and is NOT on the argv.
grep -qF "MAGPIE_FAKE_KEY=sk-magpie-live-e2e-secret" "$GUEST_LOG" \
  && pass "--env-from-host: secret value reached the guest environment" \
  || fail "--env-from-host: secret value not seen in guest env"

# 3. Gateway-shaped HTTP round-trip over the vsock-uds bridge, zero byte loss.
grep -qF "healthz-status:200" "$GUEST_LOG" && pass "guest reached gateway /healthz over --vsock-uds (200)" || fail "guest did not get 200 from /healthz"
grep -qF "chat-status:200" "$GUEST_LOG" && pass "guest got 200 from POST /v1/chat/completions over --vsock-uds" || fail "guest did not get 200 from chat-completions"
grep -qF "chat-bytes:$RESP_BYTES" "$GUEST_LOG" \
  && pass "ZERO byte loss: guest received all $RESP_BYTES reply bytes over the libkrun vsock bridge" \
  || fail "byte loss: guest did NOT receive exactly $RESP_BYTES reply bytes (see chat-bytes above)"
grep -qF "chat-json-parsed:true" "$GUEST_LOG" && pass "review-shaped reply parsed intact in the guest" || fail "guest could not parse the review-shaped reply"
grep -qF "GW: POST /v1/chat/completions" "$GW_LOG" && pass "host gateway actually received the guest's review request" || fail "host gateway never saw the guest's POST"

if [ "$FAIL" -ne 0 ]; then
  echo "" >&2; echo "one or more assertions FAILED -- see output above" >&2; exit 1
fi
echo "" >&2; echo "ALL C3 LIVE E2E ASSERTIONS PASSED" >&2
