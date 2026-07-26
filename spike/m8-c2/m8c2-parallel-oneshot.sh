#!/bin/sh
# Guest script: fires several one-shot /vsock-client dials CONCURRENTLY
# (background jobs) against the SAME uds_path, to test parallel direct
# vsock connections (assertion 3's "parallel" half) using the simplest
# possible client -- isolates this from the guest-side relay flakiness
# documented in direct-wiring-spike.md (a separate, pre-existing defect in
# rust/vsock-client unrelated to the direct-wiring hypothesis under test).
set -eu
PORT="${1:-1234}"
COUNT="${2:-5}"

i=1
while [ "$i" -le "$COUNT" ]; do
    /vsock-client "$PORT" > "/tmp/par-$i.log" 2>&1 &
    i=$((i + 1))
done
wait
i=1
while [ "$i" -le "$COUNT" ]; do
    echo "===PAR-$i==="
    cat "/tmp/par-$i.log"
    i=$((i + 1))
done
echo "===PARALLEL-ONESHOT-DONE==="
