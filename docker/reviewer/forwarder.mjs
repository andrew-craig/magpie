#!/usr/bin/env node
// magpie-reviewer in-container TCP -> unix domain socket forwarder (M7-1,
// Design D — see /home/operator/magpie/DISTRIBUTION.md §2.2/§2.3).
//
// The reviewer container runs `--network none`: it has no network interfaces
// except its own loopback, so its ONLY path to the gateway is the per-job
// unix socket the orchestrator bind-mounts read-only at `/run/gw`
// (`/run/gw/gw.sock`). Pi itself is steered via a `~/.pi/agent/models.json`
// provider `baseUrl` override (see docker/reviewer/entrypoint.sh) pointed at
// `http://127.0.0.1:4000/v1` -- exactly as it was pointed at the old
// magpie-net bridge IP before Design D, so Pi's own code/flags are unchanged.
// This script is what makes that address real: it listens on the container's
// loopback (which `--network none` leaves intact) and relays each inbound
// TCP connection to the mounted unix socket.
//
// Holds no secret -- safe to ship inside the untrusted reviewer image (this
// is exactly DISTRIBUTION.md §2.3's point: the forwarder never sees
// OPENROUTER_API_KEY or anything else worth stealing, it just pipes bytes).
// Retries the unix-socket dial with a small backoff per DISTRIBUTION.md
// §2.6's "forwarder additionally retries connect() with backoff as
// belt-and-suspenders" note, in case the gateway hasn't bound the socket yet
// by the time a connection arrives (shouldn't happen given the launch
// ordering the orchestrator enforces, but cheap to guard).
//
// Usage: node forwarder.mjs [socketPath]
//   socketPath: defaults to $MAGPIE_GW_SOCKET, then /run/gw/gw.sock.

import net from "node:net";

const TCP_HOST = "127.0.0.1";
const TCP_PORT = 4000;
const SOCKET_PATH = process.argv[2] || process.env.MAGPIE_GW_SOCKET || "/run/gw/gw.sock";
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 100;

function log(msg) {
  process.stderr.write(`[forwarder] ${msg}\n`);
}

function dialUnixWithRetry(attempt = 0) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path: SOCKET_PATH });
    sock.once("connect", () => resolve(sock));
    sock.once("error", (err) => {
      if (attempt >= MAX_RETRIES) {
        reject(err);
        return;
      }
      const delay = RETRY_BASE_MS * 2 ** attempt;
      log(`connect to ${SOCKET_PATH} failed (${err.message}), retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
      setTimeout(() => {
        dialUnixWithRetry(attempt + 1).then(resolve, reject);
      }, delay);
    });
  });
}

const server = net.createServer((tcpConn) => {
  tcpConn.pause();
  dialUnixWithRetry()
    .then((unixConn) => {
      log(`relaying connection -> ${SOCKET_PATH}`);
      tcpConn.pipe(unixConn);
      unixConn.pipe(tcpConn);
      const teardown = () => {
        tcpConn.destroy();
        unixConn.destroy();
      };
      tcpConn.once("error", teardown);
      unixConn.once("error", teardown);
      tcpConn.once("close", teardown);
      unixConn.once("close", teardown);
      tcpConn.resume();
    })
    .catch((err) => {
      log(`giving up on ${SOCKET_PATH}: ${err.message}`);
      tcpConn.destroy();
    });
});

server.on("error", (err) => {
  log(`listen error: ${err.message}`);
  process.exit(1);
});

server.listen(TCP_PORT, TCP_HOST, () => {
  log(`listening on ${TCP_HOST}:${TCP_PORT} -> ${SOCKET_PATH}`);
});
