#!/usr/bin/env node
// M7-0 spike: tiny TCP -> unix domain socket relay.
//
// Runs INSIDE the reviewer container (node is already present, node:22-slim).
// Listens on 127.0.0.1:4000 (the address `~/.pi/agent/models.json`'s
// `baseUrl` points Pi at — see spike-entrypoint.sh) and, per inbound TCP
// connection, dials the mounted unix socket (path from argv[2] or
// $MAGPIE_GW_SOCKET, default /run/magpie/gw.sock) and pipes both directions.
//
// Holds no secret — safe to ship into the untrusted reviewer image (this is
// exactly DISTRIBUTION.md §2.3's point). Retries the unix-socket dial with a
// small backoff per DISTRIBUTION.md §2.6's "forwarder retries connect() with
// backoff as belt-and-suspenders" note, in case the gateway hasn't bound the
// socket yet by the time a connection arrives (shouldn't happen given the
// launch ordering, but cheap to guard).

import net from "node:net";

const TCP_HOST = "127.0.0.1";
const TCP_PORT = 4000;
const SOCKET_PATH = process.argv[2] || process.env.MAGPIE_GW_SOCKET || "/run/magpie/gw.sock";
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
