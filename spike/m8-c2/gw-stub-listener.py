#!/usr/bin/env python3
"""Host-side stand-in for the gateway's per-job `gw.sock` (M8-C2 / task_b3f7
direct-wiring spike). Adapted from spike/m8-a1/vsock-host-listener.py
(not edited in place) to additionally:

  - reproduce the REAL gateway's exact permission posture
    (packages/gateway/src/job-sockets.ts: JOB_DIR_MODE = 0o711 on the
    per-job directory, SOCKET_FILE_MODE = 0o666 on the socket file itself,
    explicit chmod AFTER listen() rather than relying on umask) -- this is
    assertion 2, the "gateway-permissions variant" crux;
  - accept MANY connections in a loop (not just one), each independently
    read-to-EOF (assertion 3: multiple/parallel connections) and each
    upstream half-close observed and propagated (assertion 4);
  - tag every log line with a caller-supplied label so two concurrent
    instances (assertion 5: per-job isolation) produce distinguishable,
    greppable logs.

Usage:
    gw-stub-listener.py <uds_path> <tag> [max_connections] [accept_timeout_s]

Prints one line per lifecycle event to stdout, all prefixed "HOST[<tag>]:".
Exits after `max_connections` accepts (default 1) or when
`accept_timeout_s` (default 10) elapses waiting for the next connection,
whichever comes first.
"""
import os
import socket
import sys
import time

JOB_DIR_MODE = 0o711  # matches packages/gateway/src/job-sockets.ts JOB_DIR_MODE
SOCKET_FILE_MODE = 0o666  # matches packages/gateway/src/job-sockets.ts SOCKET_FILE_MODE


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: gw-stub-listener.py <uds_path> <tag> [max_connections] [accept_timeout_s]", file=sys.stderr)
        return 2
    uds_path = sys.argv[1]
    tag = sys.argv[2]
    max_connections = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    accept_timeout_s = float(sys.argv[4]) if len(sys.argv) > 4 else 10.0

    job_dir = os.path.dirname(uds_path)
    # Mirror job-sockets.ts: the per-job directory is created 0711 (mkdir's
    # own mode is umask-masked, so chmod explicitly afterwards -- same
    # "never rely on umask" discipline the real module documents).
    os.makedirs(job_dir, exist_ok=True)
    os.chmod(job_dir, JOB_DIR_MODE)

    if os.path.exists(uds_path):
        os.unlink(uds_path)

    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(uds_path)
    s.listen(16)
    # Explicit chmod AFTER listen(), same ordering job-sockets.ts documents
    # ("never relying on umask -- a masked mode would silently under- or
    # over-grant").
    os.chmod(uds_path, SOCKET_FILE_MODE)

    dir_mode = oct(os.stat(job_dir).st_mode & 0o777)
    sock_mode = oct(os.stat(uds_path).st_mode & 0o777)
    print(f"HOST[{tag}]: listening on {uds_path} (dir_mode={dir_mode} sock_mode={sock_mode})", flush=True)

    s.settimeout(accept_timeout_s)
    accepted = 0
    while accepted < max_connections:
        try:
            conn, _ = s.accept()
        except socket.timeout:
            print(f"HOST[{tag}]: accept timed out after {accept_timeout_s}s ({accepted}/{max_connections} accepted)", flush=True)
            break
        accepted += 1
        conn_no = accepted
        print(f"HOST[{tag}]: accept #{conn_no}", flush=True)
        try:
            chunks = []
            while True:
                data = conn.recv(4096)
                if not data:
                    # Peer (guest) sent FIN -- half-close observed on the
                    # RECEIVING side, matching handle_connection's
                    # "relay bytes until either side closes" contract.
                    print(f"HOST[{tag}]: conn#{conn_no} EOF from guest (half-close observed)", flush=True)
                    break
                chunks.append(data)
            received = b"".join(chunks)
            print(f"HOST[{tag}]: conn#{conn_no} received {received!r}", flush=True)
            reply = b"ACK[%s]:%s" % (tag.encode(), received)
            conn.sendall(reply)
            # Same shutdown(SHUT_WR)+sleep+close shape as
            # spike/m8-a1/vsock-host-listener.py, so the guest side can
            # observe ITS OWN EOF (half-close the other direction).
            conn.shutdown(socket.SHUT_WR)
            time.sleep(0.2)
        except (BrokenPipeError, ConnectionResetError) as exc:
            print(f"HOST[{tag}]: conn#{conn_no} error: {exc!r}", flush=True)
        finally:
            conn.close()
            print(f"HOST[{tag}]: conn#{conn_no} closed", flush=True)

    s.close()
    try:
        os.unlink(uds_path)
    except FileNotFoundError:
        pass
    print(f"HOST[{tag}]: done ({accepted} connection(s) total)", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
