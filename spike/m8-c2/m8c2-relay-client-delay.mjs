#!/usr/bin/env node
// Diagnostic variant of m8c2-relay-client.mjs: same "seq" logic, but with
// an explicit delay between connections, to test whether the empty-reply
// anomaly is about connection RATE (back-to-back, near-zero gap) rather
// than about reusing one Node process for multiple net.connect() calls.
import net from "node:net";

const [, , countArg, tag, delayMsArg] = process.argv;
const count = Number.parseInt(countArg ?? "5", 10);
const delayMs = Number.parseInt(delayMsArg ?? "300", 10);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function roundtrip(label) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port: 4000 });
    let buf = "";
    let sawEnd = false;
    sock.on("connect", () => {
      sock.write(`MSG from ${label}\n`);
      sock.end();
    });
    sock.on("data", (d) => { buf += d.toString(); });
    sock.on("end", () => { sawEnd = true; });
    sock.on("close", () => resolve({ label, buf, sawEnd }));
    sock.on("error", (err) => reject(err));
  });
}

async function main() {
  for (let i = 0; i < count; i++) {
    const label = `${tag}-${i}`;
    const r = await roundtrip(label);
    console.log(`M8C2-DELAYSEQ label=${r.label} reply=${JSON.stringify(r.buf)} saw_host_eof=${r.sawEnd}`);
    await sleep(delayMs);
  }
}

main().catch((err) => {
  console.error(`M8C2-DRIVER-ERROR ${err.stack ?? err}`);
  process.exit(1);
});
