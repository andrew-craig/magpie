#!/bin/sh
# Diagnostic guest script: calls the m8-a1 one-shot /vsock-client binary N
# times in a row (sequential, no relay/TCP/node involved at all -- the
# simplest possible repeated-vsock-dial test), to isolate whether an
# anomaly seen through the full relay+node-driver stack is inherent to
# repeated direct vsock dialing itself or specific to that other stack.
set -eu
PORT="${1:-1234}"
COUNT="${2:-8}"
i=1
while [ "$i" -le "$COUNT" ]; do
    echo "===ITER $i==="
    /vsock-client "$PORT"
    echo "exit=$?"
    i=$((i + 1))
done
echo "===ONESHOT-LOOP-DONE==="
