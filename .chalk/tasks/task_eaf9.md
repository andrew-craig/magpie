---
id: task_eaf9
title: M4-C: point Pi at the gateway — base-URL override, only the virtual key in the container env
type: task
status: in_progress
priority: 1
labels: []
blocked_by: []
parent: epic_6730
remote_task_url: null
created_at: 2026-07-10T21:51:06Z
updated_at: 2026-07-11T13:03:44Z
---
Wave 2/3. Rewire the reviewer invocation so the container never sees the real provider key (PLAN.md §4/§5).

- Confirm how Pi overrides provider base URL + key (pi-ai provider config; PLAN.md assumes OPENAI_BASE_URL/OPENAI_API_KEY-style env). Pass the gateway URL (as reachable from magpie-net) and the per-job virtual key from M4-B into the docker run env; remove the long-lived provider key from the container invocation entirely.
- The real OpenRouter key must no longer appear anywhere in the reviewer path: not in the image, not in the container env, not on the workspace mount.
- If Pi turns out not to support a base-URL override, fall back to PLAN.md §5's transparent TLS-terminating credential-injecting proxy (injected CA, NODE_EXTRA_CA_CERTS) — but prefer the gateway; treat the fallback as a scope change worth flagging.

Done when: a real end-to-end review completes with the container holding only the per-job virtual key, verified by inspecting the container env.

## Review

Branch: `m4-gateway`, commit `0f67cac`.

### Provider-override finding

PLAN.md/entrypoint.sh assumed `OPENAI_BASE_URL` + `--provider openrouter` would redirect Pi's
traffic. **Empirically false for Pi 0.80.3.** Verified two ways:

1. Stub HTTP server on `127.0.0.1:5599`; ran `OPENAI_BASE_URL=http://127.0.0.1:5599/v1
   OPENROUTER_API_KEY=fake pi -p --provider openrouter --model anthropic/claude-sonnet-4.5 "say hi"`
   — the stub never received a request; Pi's own error (`401: Missing Authentication header`) is
   OpenRouter's real error string, proving the request went straight to `api.openrouter.ai`,
   env var ignored.
2. Same stub, but with `HOME` pointed at a fixture `~/.pi/agent/models.json` containing
   `{"providers":{"openrouter":{"baseUrl":"http://127.0.0.1:5599/v1"}}}` (per Pi's
   `docs/models.md` "Overriding Built-in Providers") — the stub received the request, with
   `Authorization: Bearer fake` (the env-resolved `OPENROUTER_API_KEY`) and a clean streamed
   response came back through Pi (`stopReason:"stop"`, real content). **This is the mechanism
   that actually works**: `~/.pi/agent/models.json`'s provider `baseUrl` override, keeping the
   normal `openrouter` provider (models + `OPENROUTER_API_KEY` env resolution) but redirecting
   its endpoint.

Consequence: `--provider openrouter` stays unchanged in reviewer.ts/entrypoint.sh's `pi`
invocation; `docker/reviewer/entrypoint.sh` now translates the `OPENAI_BASE_URL` env var it
receives into that `models.json` file before exec'ing `pi`, rather than relying on Pi to read
the env var itself.

### As-built changes

- `reviewer.ts`: `RunReviewParams` gains a required `gatewayApiKey: string`. `env.OPENROUTER_API_KEY`
  is now set from `params.gatewayApiKey` (never `config.secrets`, which no longer has a provider
  key at all). `dockerArgs` gains `-e OPENAI_BASE_URL=<config.gateway.containerBaseUrl>` (inline,
  non-secret) alongside the existing name-only `-e OPENROUTER_API_KEY`.
- `pipeline.ts`: threads `gatewayApiKey: gatewayKey.key` (the M4-B-minted virtual key) into the
  `runReview` call.
- `config.ts`: new `[gateway] container_base_url` (default `http://172.31.99.1:4000/v1` —
  magpie-net's fixed gateway IP on the gateway's proxy port, M4-D), loaded as
  `config.gateway.containerBaseUrl`. **Removed `MAGPIE_LLM_API_KEY` env loading and
  `secrets.llmApiKey` from the `Config` type entirely** (CTO decision) — the orchestrator no
  longer loads, holds, or can leak a real provider key.
- `docker/reviewer/entrypoint.sh`: both `OPENROUTER_API_KEY` and `OPENAI_BASE_URL` are now
  required (fail-fast, mirroring the existing `:?` guard). Writes `$HOME/.pi/agent/models.json`
  from `OPENAI_BASE_URL` before exec'ing `pi` (flag-for-flag unchanged otherwise). **Bug found +
  fixed during live verification**: docker/runc auto-populates `HOME` from `/etc/passwd` when the
  `--user` uid matches a baked-in image account (node:22-slim ships a `node` user at uid 1000,
  which collided with the test host's uid) — landing `HOME` on the read-only rootfs. A
  default-if-unset (`: "${HOME:=/tmp}"`) doesn't help since `HOME` is already (wrongly) set;
  changed to unconditionally `export HOME=/tmp`.
- `docker/reviewer/README.md`, `config.example.toml`, `.env.example`, root `README.md`: updated to
  match (new `container_base_url` field, `MAGPIE_LLM_API_KEY` removed from all secret docs).
- Tests updated across `config.test.ts`, `reviewer.test.ts`, `pipeline.test.ts`, `docker.test.ts`,
  `orphan-cleanup.test.ts`, `server.test.ts`, `gateway.test.ts` (fixture `Config` objects gain
  `gateway.containerBaseUrl`, drop `secrets.llmApiKey`); added a `pipeline.test.ts` case asserting
  the minted virtual key reaches the container's `OPENROUTER_API_KEY` verbatim, and a
  `reviewer.test.ts` assertion for the `-e OPENAI_BASE_URL=...` argv token.

### Verification evidence

1. **Build/test**: `npm run build --workspaces` clean (tsc, all 3 packages). `npm run
   test --workspaces`: gateway 49/49, review-extension 11/11, orchestrator 188/188 (run per-package
   to avoid one pre-existing timing-sensitive flake in `reviewer.test.ts`'s abort-kill test that
   also fails identically on unmodified `main` under this sandbox's parallel-workspace CPU load —
   confirmed via `git stash` + rerun; not introduced by this change). `tsc --noEmit` clean for the
   build config; a couple of pre-existing (unrelated, pre-dating this branch) type errors exist in
   `publisher.test.ts`/`github.test.ts`/`pipeline.test.ts` only when forcibly including test files
   in a `tsc` run outside the normal `exclude`d build config — reproduced identically on
   unmodified `main`, not touched by this task.
2. **Provider-override finding**: see above.
3. **Focused local E2E through the full chain** (no webhook/PR, per CTO scope): started
   `packages/gateway` bound to `172.31.99.1:4000` (real key from repo-root `.env`'s
   `MAGPIE_LLM_API_KEY`, re-keyed into the gateway's own `MAGPIE_GATEWAY_OPENROUTER_KEY`, plus a
   fresh master key) on the already-provisioned `magpie-net` (`--internal`, iptables live from
   M4-D). Minted a real virtual key via `mintGatewayKeyFromConfig`, then called `runReview()`
   directly against a real small checkout (`/tmp/m4c-e2e/workspace/e2e-probe-m4c.js`, two
   intentional bugs) with `container.network: "magpie-net"`, `gateway.containerBaseUrl:
   "http://172.31.99.1:4000/v1"`, model `z-ai/glm-5.2` (same model verified live in M3-D). Result:
   `{ ok: true, findingsCount: 2, verdict: "comment", usage: { turns: 1, totalTokens: 3919, costUsd:
   0.0029 } }` — both intentional bugs (inverted `clamp` upper bound, `isEven` testing odd) correctly
   identified. LLM traffic flowed through the gateway (confirmed real OpenRouter cost/tokens
   returned, not a stub).
4. **Container holds ONLY the virtual key**: polled `docker inspect <container>
   --format '{{json .Config.Env}}'` while the container was running (a `setInterval` poll racing the
   `runReview()` call). Captured env: `OPENROUTER_API_KEY` value has `matchesVirtualKey=true`
   (byte-for-byte equal to the freshly minted key) and `OPENAI_BASE_URL=http://172.31.99.1:4000/v1`.
   Grepped the real key's value (read from `.env`, never printed) against the gateway process log,
   both E2E run logs, and confirmed **absent from all of them** (present only in the gateway
   process's own private `.env`-style file, its intended/sole location).
5. **Network lockdown sanity** (M4-D, unmodified by this task): from a plain container on
   `magpie-net`, `http://172.31.99.1:4000/healthz` succeeds; `https://openrouter.ai`,
   `https://github.com`, and the cloud-metadata IP (`169.254.169.254`) all fail (`fetch failed`) —
   the gateway is the only reachable destination.

### Interpretation notes for the tech lead

- Followed the CTO's "focused local E2E, no webhook/PR" scope literally: drove `runReview()`
  directly rather than through a full webhook → pipeline → GitHub-comment round trip.
- The HOME/uid-collision bug was not anticipated by the task brief; fixed it in `entrypoint.sh`
  and re-verified live rather than flagging it as a scope change, since it's a direct correctness
  bug in the mechanism this task was implementing (M4-C's own `models.json` translation), not new
  scope.
- Did not build PLAN.md §5's TLS-terminating-proxy fallback — the gateway/models.json mechanism
  works, so it was never needed.
