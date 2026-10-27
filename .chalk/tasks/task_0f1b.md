---
id: task_0f1b
title: scripts/test-zero-egress.sh references stripped spike/m7-0 gateway-on-socket.mjs
type: task
status: open
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-10-25T05:38:54Z
updated_at: 2026-10-25T05:38:54Z
---


Follow-up from task_d8d6 / PR #91. `scripts/test-zero-egress.sh` (manual, non-CI zero-egress proof for the `--network none` reviewer) starts its stub gateway from `spike/m7-0/gateway-on-socket.mjs`, which PR #75 (f0bd7a9) deleted with the rest of `spike/`. The script dies immediately on main.

## Plan
- [ ] Restore the stub as a maintained fixture at `scripts/lib/stub-gateway-on-socket.mjs` (from `git show 0ec7b7e:spike/m7-0/gateway-on-socket.mjs`): real compiled `packages/gateway/dist` proxy server bound to a unix socket, upstream stubbed via `fetchImpl`, dummy secrets. Fix the dist path for its new location and re-check every import/signature against today's gateway (`loadGatewayConfig`, `createKeyStore().mint`, `createProxyServer` options; gateway has changed since July, e.g. job-sockets.ts). Drop "spike" wording.
- [ ] `scripts/test-zero-egress.sh`: replace `SPIKE_DIR`/`spike/m7-0` references with the new path, fix header comments (no more run-spike.sh), check the fixture `MODEL` and the probe/real-entrypoint `run` flags still match what `reviewer.ts` passes today (e.g. the socket mount path, env vars the entrypoint now requires, tier-memory asserts), and the default image name.
- [ ] Also fix `rust/magpie-microvm-launcher/smoke-test.sh` spike/m8-a1 reference? -> out of scope; note it only (same PR #75 caveat). Create a follow-up task if it's broken.
- [ ] Validate: build gateway (`npm run gateway:build`), build or use a local reviewer image, run `DOCKER_BIN=podman ./scripts/test-zero-egress.sh` on this host, and get `VERDICT: PASS` with the real-entrypoint round-trip leg executed (not skipped). Restore discipline: remove only the test image tag we created, never prune.
