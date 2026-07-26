#!/usr/bin/env node
// Guest-side driver for the M8-C2 direct-wiring spike (assertions 3, 4, 5).
// Drives real TCP traffic against 127.0.0.1:4000 -- the SAME address Pi's
// OPENAI_BASE_URL targets in production (see rust/vsock-client/src/main.rs's
// module doc comment) -- which /m8c2-relay (the real, unmodified
// `magpie-vsock-client` production binary, just copied into this rootfs
// under a different name so it doesn't collide with the m8-a1 one-shot
// /vsock-client the baseline smoke test uses) relays over AF_VSOCK to the
// host's gw-stub-listener.py.
//
// Every round-trip here exercises half-close both directions in one shot
// (assertion 4): this client calls `socket.end()` right after writing (FIN
// on the write side, still readable) -- the host listener must see that as
// recv() returning b'' (guest->host EOF propagation) -- and the host then
// half-closes its OWN write side after replying, which must surface here as
// the 'end' event (host->guest EOF propagation) before 'close'.
//
// Usage: node m8c2-relay-client.mjs <mode> <count> <tag>
//   mode: seq | par | iso
//   count: number of connections (iso always uses 1 regardless of count)
//   tag: label baked into every payload + printed marker, so a human (or a
//        grep) can tell which VM/run produced which line -- this is what
//        makes the per-job isolation check (assertion 5) meaningful despite
//        both VMs otherwise running byte-identical guest code.
import net from "node:net";

const [, , mode, countArg, tag] = process.argv;
const count = Number.parseInt(countArg ?? "5", 10);

function roundtrip(label) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port: 4000 });
    let buf = "";
    let sawEnd = false;
    const timer = setTimeout(() => {
      reject(new Error(`${label}: timed out waiting for round-trip`));
      sock.destroy();
    }, 8000);
    sock.on("connect", () => {
      sock.write(`MSG from ${label}\n`);
      sock.end(); // half-close: FIN after write, socket stays readable
    });
    sock.on("data", (d) => {
      buf += d.toString();
    });
    sock.on("end", () => {
      sawEnd = true; // host's shutdown(SHUT_WR) surfaced here
    });
    sock.on("close", () => {
      clearTimeout(timer);
      resolve({ label, buf, sawEnd });
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function main() {
  if (mode === "seq") {
    for (let i = 0; i < count; i++) {
      const label = `${tag}-seq-${i}`;
      const r = await roundtrip(label);
      console.log(
        `M8C2-SEQ label=${r.label} reply=${JSON.stringify(r.buf)} saw_host_eof=${r.sawEnd}`,
      );
    }
  } else if (mode === "par") {
    const labels = Array.from({ length: count }, (_, i) => `${tag}-par-${i}`);
    const results = await Promise.all(labels.map((l) => roundtrip(l)));
    for (const r of results) {
      console.log(
        `M8C2-PAR label=${r.label} reply=${JSON.stringify(r.buf)} saw_host_eof=${r.sawEnd}`,
      );
    }
  } else if (mode === "iso") {
    const r = await roundtrip(tag);
    console.log(
      `M8C2-ISO label=${r.label} reply=${JSON.stringify(r.buf)} saw_host_eof=${r.sawEnd}`,
    );
  } else {
    console.error(`unknown mode: ${mode}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(`M8C2-DRIVER-ERROR ${err.stack ?? err}`);
  process.exit(1);
});
