#!/bin/sh
# Guest bootstrap for the M8-C2 direct-wiring spike (assertions 3, 4, 5).
# Installed into spike/m8-a1/rootfs at runtime by the run-*.sh scripts in
# this directory, same convention smoke-test.sh already uses for
# smoke-probe.sh (the rootfs dir is gitignored/regenerable, so this is not
# an edit of any committed m8-a1 file).
#
# Starts the REAL magpie-vsock-client relay binary (copied in as
# /m8c2-relay, unmodified from rust/target/release/magpie-vsock-client) in
# the background, waits for it to open its TCP listener (which only
# happens after ITS OWN preflight vsock connect to the host succeeds -- see
# rust/vsock-client/src/main.rs), then drives the node test client against
# it in the requested mode.
#
# usage: m8c2-driver.sh <vsock-port> <mode> <count> <tag>
#   mode: seq | par | iso | both  ("both" runs seq then par)
set -eu
PORT="${1:-1234}"
MODE="${2:-both}"
COUNT="${3:-5}"
TAG="${4:-guest}"

echo "===M8C2-RELAY-START==="
MAGPIE_VSOCK_PORT="$PORT" /m8c2-relay >/tmp/m8c2-relay.log 2>&1 &
RELAY_PID=$!

echo "===M8C2-WAIT-FOR-RELAY-TCP==="
i=0
until node -e '
const net = require("net");
const s = net.connect({host:"127.0.0.1", port:4000}, () => { s.end(); process.exit(0); });
s.on("error", () => process.exit(1));
' 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 50 ]; then
        echo "relay TCP listener never came up -- relay log:" >&2
        cat /tmp/m8c2-relay.log >&2
        exit 1
    fi
    sleep 0.1
done
echo "relay TCP listener is up after $i poll(s)"

run_mode() {
    node /m8c2-relay-client.mjs "$1" "$COUNT" "$TAG"
}

case "$MODE" in
    both)
        echo "===M8C2-SEQ==="
        run_mode seq
        echo "===M8C2-PAR==="
        run_mode par
        ;;
    seq|par|iso)
        echo "===M8C2-${MODE}==="
        run_mode "$MODE"
        ;;
    *)
        echo "unknown mode: $MODE" >&2
        exit 2
        ;;
esac

echo "===M8C2-RELAY-LOG==="
cat /tmp/m8c2-relay.log

kill "$RELAY_PID" 2>/dev/null || true
echo "===M8C2-DONE==="
