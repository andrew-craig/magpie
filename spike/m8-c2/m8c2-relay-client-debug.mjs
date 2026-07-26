#!/usr/bin/env node
// Instrumented variant of m8c2-relay-client.mjs, used only to diagnose the
// intermittent empty-reply anomaly seen through the relay+node stack (see
// direct-wiring-spike.md). Logs every socket event with a timestamp and
// exact byte count, for ONE connection only.
import net from "node:net";

const label = process.argv[2] ?? "debug";
const t0 = Date.now();
const log = (msg) => console.log(`[${Date.now() - t0}ms] ${msg}`);

const sock = net.connect({ host: "127.0.0.1", port: 4000 });
sock.on("connect", () => {
  log("connect event fired");
  const ok = sock.write(`MSG from ${label}\n`);
  log(`write() returned ${ok}`);
  sock.end();
  log("end() called");
});
sock.on("data", (d) => {
  log(`data event: ${d.length} bytes: ${JSON.stringify(d.toString())}`);
});
sock.on("end", () => log("end event (remote FIN)"));
sock.on("finish", () => log("finish event (our writes flushed)"));
sock.on("close", (hadError) => {
  log(`close event (hadError=${hadError})`);
  process.exit(0);
});
sock.on("error", (err) => log(`error event: ${err.stack}`));
sock.on("timeout", () => log("timeout event"));
