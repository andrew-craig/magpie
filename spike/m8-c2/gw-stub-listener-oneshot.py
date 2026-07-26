#!/usr/bin/env python3
"""One-shot host-side stand-in for the gateway's `gw.sock`, used only by
assertion 2 (the gateway-permissions variant) against the m8-a1 spike's
prebuilt one-shot `/vsock-client` binary.

Deliberately mirrors spike/m8-a1/vsock-host-listener.py's protocol EXACTLY
(single `recv()` call, then reply, then shutdown(SHUT_WR)) rather than
gw-stub-listener.py's read-until-EOF loop: the m8-a1 client writes ONE
message and then blocks on `read()` for the reply WITHOUT ever half-closing
its write side first, so a listener that waits for EOF before replying (as
an earlier version of this spike's gw-stub-listener.py did) deadlocks
forever -- that was a bug in the test harness, not a finding about direct
wiring (see direct-wiring-spike.md's "harness bug" note). This script fixes
that by using the same single-recv-then-reply shape as the known-good
baseline listener, just with the gateway's real 0711/0666 permission
posture layered on top.

Usage: gw-stub-listener-oneshot.py <uds_path> <tag>
"""
import os
import socket
import sys
import time

JOB_DIR_MODE = 0o711
SOCKET_FILE_MODE = 0o666


def main() -> int:
    uds_path, tag = sys.argv[1], sys.argv[2]
    job_dir = os.path.dirname(uds_path)
    os.makedirs(job_dir, exist_ok=True)
    os.chmod(job_dir, JOB_DIR_MODE)

    if os.path.exists(uds_path):
        os.unlink(uds_path)
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(uds_path)
    s.listen(1)
    os.chmod(uds_path, SOCKET_FILE_MODE)

    dir_mode = oct(os.stat(job_dir).st_mode & 0o777)
    sock_mode = oct(os.stat(uds_path).st_mode & 0o777)
    print(f"HOST[{tag}]: listening on {uds_path} (dir_mode={dir_mode} sock_mode={sock_mode})", flush=True)

    conn, _ = s.accept()
    data = conn.recv(256)
    print(f"HOST[{tag}]: received {data!r}", flush=True)
    conn.sendall(b"PONG from host gateway (uid=%d)\n" % os.getuid())
    conn.shutdown(socket.SHUT_WR)
    time.sleep(0.5)
    conn.close()
    s.close()
    os.unlink(uds_path)
    print(f"HOST[{tag}]: done", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
