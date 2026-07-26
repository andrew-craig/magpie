#!/bin/sh
# Guest-side probe script for task_76d6's live smoke test
# (rust/magpie-microvm-launcher/smoke-test.sh). Lives as a real multi-line
# FILE in the rootfs (not packed onto libkrun's kernel cmdline), so none of
# the ASCII/no-newline cmdline constraints src/config.rs enforces apply to
# it -- only the launcher's `--exec /smoke-probe.sh` argv entry itself needs
# to be (and is) a short, plain-ASCII path.
echo "===ID==="
id
echo "===IFACES==="
ls /sys/class/net
echo "===DUMMY0-OPERSTATE==="
cat /sys/class/net/dummy0/operstate 2>&1
echo "===ROUTE-COUNT==="
awk 'END{print NR-1}' /proc/net/route
echo "===NPROC==="
nproc
echo "===MEMTOTAL==="
grep MemTotal /proc/meminfo
echo "===EGRESS==="
node -e '
const s = require("net").connect({ host: "1.1.1.1", port: 443 }, () => {
  console.log("EGRESS-OK-BAD");
  process.exit(1);
});
s.on("error", (e) => {
  console.log("blocked:", e.code);
  process.exit(0);
});
setTimeout(() => {
  console.log("timeout");
  process.exit(2);
}, 5000);
'
echo "===VSOCK==="
/vsock-client 1234
echo "===WORKMOUNT==="
mount -t virtiofs work /work && ls -la /work && cat /work/sample.js
echo "===WORKMOUNT-WRITE-ATTEMPT==="
if touch /work/should-fail 2>&1; then
  echo BAD-WRITABLE
else
  echo good-read-only
fi
echo "===DONE==="
