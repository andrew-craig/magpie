#!/bin/bash
echo "===IFACES==="
ls /sys/class/net
for f in /sys/class/net/*; do
  n=$(basename "$f")
  [ "$n" = "lo" ] && continue
  echo "=== $n operstate: $(cat "$f/operstate" 2>&1) carrier: $(cat "$f/carrier" 2>&1) flags: $(cat "$f/flags" 2>&1)"
done
echo "===ROUTE4==="
cat /proc/net/route
echo "===EGRESS==="
timeout 5 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' && echo "EGRESS-REACHABLE-BAD" || echo "egress-blocked-good"
echo "===DONE==="
