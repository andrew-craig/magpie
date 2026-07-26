#!/usr/bin/env python3
"""Diagnostic variant of gw-stub-listener-oneshot.py: accepts MANY
sequential connections, each following the exact single-recv-then-reply
protocol the m8-a1 one-shot /vsock-client speaks (no read-until-EOF loop).
Used to isolate whether an anomaly seen through the full
relay+node-driver stack (run-assertion345.sh) is a problem with direct
vsock dialing itself, or with that other, more complex stack.

Usage: gw-stub-listener-oneshot-multi.py <uds_path> <tag> <count>
"""
import os
import socket
import sys
import time

JOB_DIR_MODE = 0o711
SOCKET_FILE_MODE = 0o666


def main() -> int:
    uds_path, tag, count = sys.argv[1], sys.argv[2], int(sys.argv[3])
    job_dir = os.path.dirname(uds_path)
    os.makedirs(job_dir, exist_ok=True)
    os.chmod(job_dir, JOB_DIR_MODE)

    if os.path.exists(uds_path):
        os.unlink(uds_path)
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(uds_path)
    s.listen(16)
    os.chmod(uds_path, SOCKET_FILE_MODE)
    print(f"HOST[{tag}]: listening on {uds_path}", flush=True)

    s.settimeout(15)
    for i in range(1, count + 1):
        try:
            conn, _ = s.accept()
        except socket.timeout:
            print(f"HOST[{tag}]: accept #{i} timed out", flush=True)
            break
        data = conn.recv(256)
        print(f"HOST[{tag}]: conn#{i} received {data!r}", flush=True)
        conn.sendall(b"PONG#%d from host gateway (uid=%d)\n" % (i, os.getuid()))
        conn.shutdown(socket.SHUT_WR)
        time.sleep(0.2)
        conn.close()
        print(f"HOST[{tag}]: conn#{i} closed", flush=True)

    s.close()
    try:
        os.unlink(uds_path)
    except FileNotFoundError:
        pass
    print(f"HOST[{tag}]: done", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
