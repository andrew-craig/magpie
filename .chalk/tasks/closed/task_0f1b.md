---
id: task_0f1b
title: Fix dev test scripts broken by spike/ removal (test-zero-egress.sh, microvm smoke-test.sh)
type: task
status: closed
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-10-25T05:38:54Z
updated_at: 2026-10-27T22:04:08Z
---


Follow-up from task_d8d6 / PR #91. `scripts/test-zero-egress.sh` (manual, non-CI zero-egress proof for the `--network none` reviewer) starts its stub gateway from `spike/m7-0/gateway-on-socket.mjs`, which PR #75 (f0bd7a9) deleted with the rest of `spike/`. The script dies immediately on main.

## Plan
- [x] Restore the stub as a maintained fixture at `scripts/lib/stub-gateway-on-socket.mjs` (from `git show 0ec7b7e:spike/m7-0/gateway-on-socket.mjs`): real compiled `packages/gateway/dist` proxy server bound to a unix socket, upstream stubbed via `fetchImpl`, dummy secrets. Fix the dist path for its new location and re-check every import/signature against today's gateway (`loadGatewayConfig`, `createKeyStore().mint`, `createProxyServer` options; gateway has changed since July, e.g. job-sockets.ts). Drop "spike" wording.
- [x] `scripts/test-zero-egress.sh`: replace `SPIKE_DIR`/`spike/m7-0` references with the new path, fix header comments (no more run-spike.sh), check the fixture `MODEL` and the probe/real-entrypoint `run` flags still match what `reviewer.ts` passes today (e.g. the socket mount path, env vars the entrypoint now requires, tier-memory asserts), and the default image name.
- [x] **In scope (user, 2026-10-28):** `rust/magpie-microvm-launcher/smoke-test.sh` has the same breakage (PR #75 removed `spike/m8-a1`): it needs `spike/m8-a1/vsock-host-listener.py` and a pre-exported reviewer rootfs at `spike/m8-a1/rootfs/` carrying `/vsock-client`, `/probe.sh`, `/netdump.sh`. Make it self-contained: restore the listener (and probe scripts) from git history (`f47eaf3` and parents) next to the smoke test, and have the script build its own throwaway rootfs (podman create + export of a local reviewer image into a temp dir, plus `rust/vsock-client` built for the host arch and the probe scripts copied in), cleaned up on exit. Update header comments.
- [x] Validate the smoke test on this host: build the launcher, run `sg kvm -c rust/magpie-microvm-launcher/smoke-test.sh` and confirm all five checks pass.
- [x] Validate: build gateway (`npm run gateway:build`), build or use a local reviewer image, run `DOCKER_BIN=podman ./scripts/test-zero-egress.sh` on this host, and get `VERDICT: PASS` with the real-entrypoint round-trip leg executed (not skipped). Restore discipline: remove only the test image tag we created, never prune.

## Review (2026-10-28)
Done in 3449f81.
- **Stub gateway:** restored as `scripts/lib/stub-gateway-on-socket.mjs`. Gateway APIs were unchanged, so only paths and wording changed.
- **Drift fixed in `test-zero-egress.sh`:** the real-entrypoint run lacked `--memory/--cpus/--pids-limit`, `/work` (ro) + `/out` mounts, `MAGPIE_REQUIRE_MEMORY_LIMIT=true`, and podman `--userns=keep-id`, so the entrypoint's fail-closed memory assertion would have failed it. The key is now passed name-only via the environment, as in reviewer.ts.
- **`smoke-test.sh` is self-contained:** it builds a throwaway rootfs from `$MAGPIE_REVIEWER_IMAGE` (podman create+export) and a standalone static `smoke/vsock-ping-client` crate. The listener and probe live under `smoke/`. Added a vcpu==2 assertion.
- **Validation on the Pi host (podman, current reviewer image built locally):**
  - test-zero-egress: 5/5 unreachable probes, gateway socket connected, entrypoint round-trip PASS, `VERDICT: PASS`.
  - smoke-test: all 9 assertions passed.
- **Cleanup:** removed only the test tag, the builder stage and the base images the build pulled (none of them were present beforehand).
- **Note:** a podman build of the reviewer image needs an unqualified-search registry for short-name `FROM`s. A temp `CONTAINERS_REGISTRIES_CONF` was used for this; the repo is unchanged.
