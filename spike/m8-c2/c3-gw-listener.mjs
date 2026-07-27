// Host-side GATEWAY-SHAPED HTTP listener for the M8-C3 live micro-VM e2e
// (task_39ff). Binds a unix socket at argv[1] and answers exactly the two
// routes the reviewer entrypoint/Pi actually hit through the gateway:
//
//   GET  /healthz             -> 200 "ok"
//   POST /v1/chat/completions -> 200 <review-shaped JSON of a KNOWN size>
//
// It replies via res.write()/res.end() (never res.destroy(), never a
// synchronous shutdown after the last write) -- the SAME safe teardown shape
// packages/gateway/src/proxy-server.ts uses and that bug_73b2 requires. The
// launcher's `--vsock-uds` points libkrun at this socket, so a guest that
// dials vsock port 1234 (via the baked-in magpie-vsock-client TCP->vsock
// relay) reaches this server. The point of the live run is to prove a
// review-shaped request/response round-trips over the REAL libkrun vsock
// bridge with ZERO byte loss -- the transport half bug_73b2's automated
// gateway test (packages/gateway/src/proxy-server-flush.test.ts) can't cover
// because it can't boot a VM.
//
// Logs one line per lifecycle event to stdout, prefixed "GW:", so the
// orchestrating script (c3-live-e2e.sh) can assert the host actually received
// the guest's POST.

import { createServer } from "node:http";
import { existsSync, unlinkSync } from "node:fs";

const udsPath = process.argv[2];
const bodyLen = Number(process.argv[3] ?? "200000");
if (!udsPath) {
  console.error("usage: c3-gw-listener.mjs <uds-path> [body-len]");
  process.exit(2);
}

// A review-shaped chat-completion of a precisely-known byte length, so the
// guest can assert it received EVERY byte (zero loss). The `content` field is
// padded to hit exactly `bodyLen` bytes of JSON.
function reviewBody(targetLen) {
  const skeleton = {
    id: "chatcmpl-live",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0.001 },
  };
  const base = Buffer.byteLength(JSON.stringify(skeleton));
  const pad = Math.max(0, targetLen - base);
  skeleton.choices[0].message.content = "A".repeat(pad);
  return JSON.stringify(skeleton);
}

if (existsSync(udsPath)) unlinkSync(udsPath);

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    console.log("GW: GET /healthz");
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const reqBody = Buffer.concat(chunks).toString("utf-8");
      console.log(`GW: POST /v1/chat/completions req_bytes=${reqBody.length} auth=${req.headers.authorization ?? "none"}`);
      const body = reviewBody(bodyLen);
      console.log(`GW: replying resp_bytes=${Buffer.byteLength(body)}`);
      // Safe teardown shape: write then end(); libuv schedules the FIN AFTER
      // the buffer drains -- no same-tick shutdown/destroy that could race the
      // vsock-uds bridge's flush (bug_73b2).
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
    return;
  }
  console.log(`GW: 404 ${req.method} ${req.url}`);
  res.writeHead(404);
  res.end();
});

server.listen(udsPath, () => {
  console.log(`GW: listening on ${udsPath} (reply body-len ${bodyLen})`);
});
