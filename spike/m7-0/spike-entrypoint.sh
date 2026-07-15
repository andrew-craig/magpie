#!/usr/bin/env bash
set -euo pipefail

# M7-0 spike entrypoint. Runs INSIDE the reviewer container as the
# `--entrypoint` override (see run-spike.sh). Goal: get the in-container
# TCP->unix forwarder up, point Pi at it, then hand off to the REAL baked
# reviewer entrypoint (/opt/magpie/entrypoint.sh) unmodified, so the real
# confinement assertions (sk-magpie- virtual-key check, network canary
# probes, gateway /healthz-through-baseUrl check) and the real
# models.json-translation logic all run for real, over the socket transport.
#
# Mounted read-only at /opt/spike (see run-spike.sh): this script + forwarder.mjs.
# Mounted at /run/magpie (see run-spike.sh): the per-job dir containing gw.sock.

echo "[spike-entrypoint] starting forwarder.mjs (127.0.0.1:4000 -> /run/magpie/gw.sock)" >&2
node /opt/spike/forwarder.mjs /run/magpie/gw.sock &
FORWARDER_PID=$!

# Bounded wait for the forwarder's TCP listener to come up, per
# DISTRIBUTION.md §2.6's launch-ordering note ("orchestrator waits for
# gateway readiness... forwarder additionally retries connect() with backoff
# as belt-and-suspenders") -- this is the analogous wait on the OTHER end of
# the pipe: nothing downstream (Pi, the real entrypoint's healthz probe)
# should try 127.0.0.1:4000 before the forwarder is actually listening.
echo "[spike-entrypoint] waiting for 127.0.0.1:4000 to accept connections..." >&2
ready=""
for _ in $(seq 1 50); do
  if timeout 1 bash -c 'exec 3<>/dev/tcp/127.0.0.1/4000' 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.2
done

if [ -z "${ready}" ]; then
  echo "[spike-entrypoint] forwarder never came up on 127.0.0.1:4000 -- aborting" >&2
  kill "${FORWARDER_PID}" 2>/dev/null || true
  exit 1
fi
echo "[spike-entrypoint] forwarder is up" >&2

export OPENAI_BASE_URL="http://127.0.0.1:4000/v1"

# Hand off to the REAL baked entrypoint. It re-derives HOME=/tmp, writes
# ~/.pi/agent/models.json with baseUrl=$OPENAI_BASE_URL, runs its fail-closed
# confinement assertions (sk-magpie- virtual-key shape check; network
# canaries must be unreachable; gateway /healthz must be reachable -- both of
# which now transit the forwarder+socket we just brought up), and execs pi
# with "$@". Using `exec` here too so pi ultimately becomes PID 1's
# replacement... actually the real entrypoint.sh itself execs pi, replacing
# ITSELF; since we already backgrounded the forwarder, replacing this shell
# with the real entrypoint (still just a bash script, not pi yet) is fine --
# the forwarder subprocess is unaffected by an exec in its parent.
exec /opt/magpie/entrypoint.sh "$@"
