#!/bin/sh
# Guest-side probe for the M8-C3 live micro-VM e2e (task_39ff), installed into
# the reviewer rootfs and run as the launcher's `--exec` target. Proves, from
# INSIDE a real libkrun micro-VM booted by magpie-krun-launch, the three new
# C3 mechanics the automated tests can't exercise against real hardware:
#
#   1. --out-mount: mount the WRITABLE /out virtiofs device, write a
#      findings-shaped file, and read it back (the host side then confirms it
#      landed host-side).
#   2. --env-from-host: the value passed via `--env-from-host MAGPIE_FAKE_KEY`
#      arrives in the guest's environment (never on the launcher argv).
#   3. Gateway-shaped HTTP round-trip over --vsock-uds: start the baked-in
#      magpie-vsock-client TCP->vsock relay, then do GET /healthz and POST
#      /v1/chat/completions through 127.0.0.1:4000 and confirm the FULL,
#      byte-exact review-shaped reply comes back over the REAL libkrun vsock
#      bridge (the bug_73b2 transport) -- printing the received length so the
#      host can assert zero byte loss.
#
# Lives as a git-tracked FILE (not an inline cmdline arg) for the same reason
# smoke-probe.sh does: libkrun's kernel-cmdline packing is plain-ASCII /
# no-newline only.

echo "===C3-OUT-MOUNT==="
mkdir -p /out
if mount -t virtiofs out /out; then
  echo '{"findings":[],"summary":"live-e2e","verdict":"comment"}' > /out/findings.json
  echo "out-write-ok:$(cat /out/findings.json)"
else
  echo "out-mount-FAILED"
fi

echo "===C3-ENV-FROM-HOST==="
echo "MAGPIE_FAKE_KEY=${MAGPIE_FAKE_KEY:-<unset>}"

echo "===C3-RELAY-START==="
# The TCP(127.0.0.1:4000) -> AF_VSOCK(port 1234) relay baked into the reviewer
# image (magpie-vsock-client). Installed at /opt/magpie/vsock-client by the
# orchestrating script (fresh build), same slot entrypoint.sh starts under the
# micro-VM tier.
/opt/magpie/vsock-client 1234 &
RELAY_PID=$!

# Wait for the relay's TCP listener to come up.
i=0
while [ $i -lt 50 ]; do
  if node -e 'const s=require("net").connect({host:"127.0.0.1",port:4000},()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1))' 2>/dev/null; then
    break
  fi
  i=$((i+1))
  sleep 0.1
done

echo "===C3-HTTP-ROUNDTRIP==="
# GET /healthz then POST /v1/chat/completions (review-shaped), each over its
# own connection (Connection: close) -- the same shape the real entrypoint
# uses (a /dev/tcp healthz probe, then Pi's request). Print the exact received
# body length so the host can assert byte-for-byte delivery.
node -e '
const http = require("http");
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: 4000, method, path,
      headers: { "content-type": "application/json", "connection": "close",
        ...(body ? { "content-length": Buffer.byteLength(body) } : {}) } },
      (res) => { const cs=[]; res.on("data",c=>cs.push(c));
        res.on("end",()=>resolve({status:res.statusCode, body:Buffer.concat(cs)})); });
    r.on("error", reject);
    r.end(body);
  });
}
(async () => {
  const h = await req("GET", "/healthz");
  console.log("healthz-status:" + h.status + " healthz-body:" + h.body.toString());
  const chat = await req("POST", "/v1/chat/completions", JSON.stringify({model:"m",messages:[{role:"user",content:"review this"}]}));
  console.log("chat-status:" + chat.status + " chat-bytes:" + chat.body.length);
  // Parse + surface the first/last bytes so a truncated or corrupted reply is
  // obvious, not just a length match.
  let ok = false;
  try { const j = JSON.parse(chat.body.toString()); ok = j.choices && j.choices[0].message.role === "assistant"; } catch (e) {}
  console.log("chat-json-parsed:" + ok + " chat-first16:" + chat.body.slice(0,16).toString());
})().catch(e => { console.log("http-roundtrip-ERROR:" + e.message); });
'

kill "$RELAY_PID" 2>/dev/null
echo "===C3-DONE==="
