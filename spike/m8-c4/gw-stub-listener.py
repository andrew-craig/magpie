#!/usr/bin/env python3
"""spike/m8-c4/gw-stub-listener.py -- minimal host-side gateway-shaped stub
for task_3b48 (M8-C4)'s negative-test harness.

Listens on a UNIX socket (the same shape as the gateway's real per-job
proxy-plane socket -- packages/gateway/src/job-sockets.ts) and, for every
accepted connection, replies with a fixed "HTTP/1.1 200 OK" response
regardless of what (if anything) was sent. This is NOT a real gateway --
just enough to satisfy:
  1. magpie-vsock-client's (rust/vsock-client) startup preflight connect
     (which sends nothing and just proves reachability), and
  2. entrypoint.sh's own `GET /healthz` reachability probe
     (magpie_http_get_200 in docker/reviewer/entrypoint.sh), so the POSITIVE
     (TSI-off) boot can proceed all the way through the network-confinement
     block to "network confinement verified" and beyond, exactly like a real
     job would.

Runs until killed (SIGTERM/Ctrl-C) or the parent process group exits, and
accepts an unbounded number of connections concurrently (each on its own
thread) since a single job can open several: the vsock-client preflight, the
entrypoint's own /healthz probe, and (if the guest gets that far) Pi's own
traffic.
"""
import os
import socket
import sys
import threading

RESPONSE = (
    b"HTTP/1.1 200 OK\r\n"
    b"Content-Type: text/plain\r\n"
    b"Content-Length: 2\r\n"
    b"Connection: close\r\n"
    b"\r\n"
    b"ok"
)


def handle(conn: socket.socket) -> None:
    try:
        conn.settimeout(5)
        try:
            conn.recv(4096)
        except OSError:
            pass
        try:
            conn.sendall(RESPONSE)
        except OSError:
            pass
    finally:
        try:
            conn.shutdown(socket.SHUT_WR)
        except OSError:
            pass
        conn.close()


def main() -> None:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <uds-path>", file=sys.stderr)
        sys.exit(2)
    uds_path = sys.argv[1]
    if os.path.exists(uds_path):
        os.unlink(uds_path)

    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(uds_path)
    srv.listen(16)
    print(f"gw-stub-listener: listening on {uds_path}", flush=True)

    try:
        while True:
            conn, _ = srv.accept()
            print("gw-stub-listener: accepted a connection", flush=True)
            threading.Thread(target=handle, args=(conn,), daemon=True).start()
    except KeyboardInterrupt:
        pass
    finally:
        srv.close()
        if os.path.exists(uds_path):
            os.unlink(uds_path)


if __name__ == "__main__":
    main()
