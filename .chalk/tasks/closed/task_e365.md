---
id: task_e365
title: M7-0: Feasibility spike — Pi reaches the gateway over a unix socket via an in-container forwarder
type: task
status: closed
priority: 1
labels: [distribution,spike]
blocked_by: []
parent: epic_0162
remote_task_url: null
created_at: 2026-07-12T13:34:18Z
updated_at: 2026-07-13T13:23:18Z
---
GATE for the whole epic. Prove Design D's reviewer->gateway channel works end-to-end at the pinned Pi version (0.80.3): reviewer container runs --network none (loopback only); a tiny TCP->unix forwarder listens on 127.0.0.1:4000 inside it; docker/reviewer/entrypoint.sh writes ~/.pi/agent/models.json baseUrl=http://127.0.0.1:4000/v1 (as it already does for the gateway URL, see reviewer.ts:32-41); the forwarder relays to a mounted unix socket served by the gateway; a real chat-completions request returns. reviewer.ts already relies on Pi honouring an arbitrary HTTP baseUrl, so this should work — but it gates the architecture, so verify before the build tasks proceed. Fallback: if Pi ever grows native unix-socket support, drop the forwarder.

---

## Plan (throwaway spike — NOT production code; findings feed M7-1)

This spike de-risks the ONE novel piece of Design D: the reviewer->gateway
**transport** (Pi over container loopback -> in-container TCP->unix forwarder
-> mounted unix socket -> gateway). The gateway->OpenRouter leg is unchanged
from M4 and already proven in production, so the spike stubs the upstream and
does NOT spend real tokens by default (optional real-key run available).

### Components to build (all under `spike/m7-0/`, deleted/kept as reference after)
1. **`forwarder.mjs`** — ~20-line Node `net` TCP->unix relay. Listens on
   `127.0.0.1:4000`, and for each connection dials the mounted unix socket
   (`/run/gw.sock`) and pipes both directions. Node is already in the reviewer
   image (`node:22-slim`), so no new image dependency; holds no secret.
2. **`spike-entrypoint.sh`** — start `forwarder.mjs` in the background, wait
   for `127.0.0.1:4000` to accept, then run the EXISTING baked reviewer flow
   with `OPENAI_BASE_URL=http://127.0.0.1:4000/v1`. Reuses the image's baked
   `/opt/magpie` prompt+extension and (as far as possible) the real
   `entrypoint.sh` confinement assertions, which under `--network none` should
   pass: canaries (1.1.1.1:443, github.com:443) unreachable; gateway `/healthz`
   reachable *through the forwarder over the socket*.
3. **`gateway-on-socket.mjs`** — launches the REAL compiled gateway
   `createProxyServer(...)` (packages/gateway) but binds its `.server` to a
   unix socket path via `server.listen(socketPath)` instead of host:port, then
   `chmod 0666` the socket (per DISTRIBUTION.md §2.6). Upstream is a local
   **stub** (via the `fetchImpl` seam / a tiny stub server) returning a valid
   OpenAI chat-completion, so no real key/cost. Mints one real `sk-magpie-`
   virtual key in its keystore so budget + the entrypoint's virtual-key
   assertion are exercised for real.
4. **`run-spike.sh`** — orchestrates: create job dir (`0711`), start gateway on
   socket, wait for socket ready, then `docker run --rm --network none
   --entrypoint <spike-entrypoint> -v <jobdir>:/run/magpie -e OPENROUTER_API_KEY=<vkey>
   ... magpie-reviewer:latest --provider openrouter --model <model>` with a
   tiny PR payload on stdin. Mirrors the real reviewer.ts hardening flags.

### Pass/fail criteria (the GATE)
- **PASS** iff, with the container on `--network none`, Pi emits a non-error
  chat completion (a `message_end`/`agent_end` assistant turn, `stopReason` not
  `error`) that demonstrably transited the unix socket (gateway logs the
  request; stub returns the reply). Confirms Pi 0.80.3 honours the loopback
  `models.json baseUrl` and the forwarder->socket path carries real traffic.
- Also assert the confinement holds: canary probes fail (no egress), gateway
  reachable only via the socket, and `docker run` still succeeds with the full
  hardening flag set (`--read-only`, `--cap-drop=ALL`, etc.) plus `--network none`.
- **FAIL** -> record exactly where (Pi ignores loopback baseUrl / forwarder
  can't bind on `--network none` / socket perms / mount clobber) and evaluate
  the DISTRIBUTION.md fallbacks before M7-1 proceeds.

### Deliverables
- Working spike scripts on branch `m7-0-spike`.
- A **"### Review / Spike results"** section in this task: PASS/FAIL, captured
  output, and any gotchas M7-1 must carry forward (socket perms, launch
  ordering, forwarder readiness, whether the real entrypoint needed changes).

### Notes / decisions
- Upstream stubbed by default (transport is the risk; OpenRouter leg is proven).
  Optional real end-to-end run if a real key is provided (prod key is in a
  root-owned 600 file this session can't read).
- Spike code is throwaway; M7-1 productionises the forwarder + entrypoint +
  gateway-socket support and deletes the pinned-network apparatus.

### Review / Spike results

**PASS**

Ran twice (fresh job dir/socket/vkey each time) on this host (Docker 29.6.1,
Pi 0.80.3 baked into `magpie-reviewer:latest`); both runs produced an
identical verdict.

Exact command:

```
/home/operator/magpie/spike/m7-0/run-spike.sh
```

which internally invokes (mirrors reviewer.ts's `dockerArgs`, lines ~318-352,
except `--network none` in place of `config.container.network` and the added
socket-dir mount + `--entrypoint` override):

```
docker run --rm \
  --network none \
  --entrypoint /opt/spike/spike-entrypoint.sh \
  --user "$(id -u):$(id -g)" \
  --read-only --tmpfs /tmp \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --memory=512m --cpus=1 --pids-limit=128 \
  -v "<jobdir>:/run/magpie:ro" \
  -v "<spikedir>:/opt/spike:ro" \
  -e OPENROUTER_API_KEY=<minted sk-magpie- vkey> \
  -e OPENAI_BASE_URL=http://127.0.0.1:4000/v1 \
  -i magpie-reviewer:latest \
  --provider openrouter --model z-ai/glm-5.2
```
with a minimal `<UNTRUSTED_PR_DATA nonce="...">`-fenced fixture PR piped on stdin.

Key captured output:

- Gateway log (real `createProxyServer` bound to the unix socket, stubbed
  upstream): `[socket-request #1] GET /healthz`, `[socket-request #2] POST
  /v1/chat/completions ... stream=true` — proves both the real entrypoint's
  `/healthz` confinement probe AND Pi's actual chat-completion request
  transited the mounted socket via the forwarder.
- Pi's NDJSON (`--mode json`) stdout included, on both runs, a clean turn:
  `{"type":"message_end","message":{...,"stopReason":"stop",...}}` followed by
  `{"type":"turn_end",...}` and `{"type":"agent_end","messages":[...],"willRetry":false}`
  — no `stopReason:"error"` anywhere in the stream, i.e. Pi completed a real
  chat turn using the loopback `baseUrl`.
- Container exited `0` both runs (the real `docker/reviewer/entrypoint.sh`'s
  fail-closed assertions — `sk-magpie-` prefix check, `1.1.1.1:443` +
  `github.com:443` canaries must be unreachable, gateway `/healthz` through
  `OPENAI_BASE_URL` must be reachable — all passed silently; any failure
  there prints `"magpie-reviewer: refusing to run..."` to stderr and exits
  non-zero, which did not occur).
- `docker run` used the full hardening flag set
  (`--read-only --tmpfs /tmp --cap-drop=ALL --security-opt=no-new-privileges
  --memory --cpus --pids-limit --user <uid>:<gid>`) plus `--network none` —
  no other network attached.
- No code changes were needed to `docker/reviewer/entrypoint.sh` — the spike
  entrypoint (`spike-entrypoint.sh`) starts the forwarder, waits for
  `127.0.0.1:4000` to accept, exports `OPENAI_BASE_URL=http://127.0.0.1:4000/v1`,
  then `exec`s the image's real, unmodified `/opt/magpie/entrypoint.sh "$@"` —
  so the real models.json translation and both confinement assertions ran
  for real, over the socket transport, unmodified.

Gotchas / decisions for M7-1:

- **Launch ordering matters and worked as designed**: job dir created first
  (`0711`) → gateway binds the socket inside it and `chmod 0666`s it → orchestrator
  (`run-spike.sh`) polls for the socket file + a `GATEWAY_READY` stdout marker
  before `docker run` → container's forwarder additionally retries `connect()`
  with backoff. Mounting the pre-created **directory** (never the not-yet-existent
  socket file) as the bind-mount source, per DISTRIBUTION.md §2.6, avoided any
  Docker-invented root-owned path.
- **Socket perms**: `0666` explicit `chmod` after `bind()` was sufficient for
  the (same-uid, in this spike) reviewer to `connect()` through a `0711`,
  **read-only** bind-mounted directory — confirms `connect()` is unaffected by
  the read-only mount, only FS mutations are (as DISTRIBUTION.md §2.6 predicts).
  Production must still separate the gateway's own host-user from the
  reviewer's — this spike ran both as the same host uid for simplicity, so it
  did not exercise the cross-user case, only the mount/perms mechanics.
- **Forwarder readiness ordering is real**: the real entrypoint's `/healthz`
  probe fires almost immediately after `HOME` setup; without the
  spike-entrypoint's bounded wait-for-4000-to-accept loop, that probe would
  race the forwarder's listen() and could flake. Belt-and-suspenders retry
  inside `forwarder.mjs`'s own unix-side `connect()` (backoff, 5 attempts)
  was not actually exercised this run since the gateway was always up first,
  but costs nothing and should be kept in the productionized version.
- **Pi genuinely honours the loopback `models.json` baseUrl** exactly as
  `reviewer.ts`'s doc comments assert for the plain-TCP-gateway case — this
  spike is the first proof that holds under `--network none` (no route to
  anything but loopback) rather than a normal bridge network. No fallback
  needed.
- **Pi sends `stream:true`** for this CLI invocation shape (`-p --mode json`),
  so the gateway's SSE relay path (and the stub's SSE branch, and
  `determineCost`'s SSE parser) is the one that actually gets exercised end to
  end, not the plain-JSON path — worth keeping in mind for M7-1's own testing
  (don't only test the non-streaming branch).
- **Host quirk, not a spike defect**: `docker run --memory=...` printed
  `WARNING: Your kernel does not support memory limit capabilities or the
  cgroup is not mounted. Limitation discarded.` on this dev host (Raspberry
  Pi kernel) — the flag was accepted but not enforced. Unrelated to Design D;
  note for whoever validates M7-1 on the actual target host that cgroup memory
  accounting should be confirmed there.
- No FAIL fallback paths were needed — Design D's transport works as specified.
