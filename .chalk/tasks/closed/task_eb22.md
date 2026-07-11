---
id: task_eb22
title: M4-A: LiteLLM gateway service — own user, real provider key, OpenAI-compatible endpoint
type: task
status: closed
priority: 1
labels: []
blocked_by: []
parent: epic_6730
remote_task_url: null
created_at: 2026-07-10T21:50:44Z
updated_at: 2026-07-11T03:21:22Z
---
Wave 1. Stand up the host-side LiteLLM proxy per PLAN.md §5.

- gateway/litellm.config.yaml: model routing to OpenRouter, real OPENROUTER_API_KEY held only here (env/file readable by the gateway user only), virtual-key/budget support enabled (master key + key DB as LiteLLM requires).
- Runs on the host as its OWN unprivileged user, outside the container's blast radius; listens only on the address the magpie-net bridge will reach (plus localhost for the orchestrator's key-management calls) — never 0.0.0.0.
- Pin the LiteLLM version; document how to install/run it (systemd unit itself can land in M5, but the service must be runnable and documented now).
- Optional defense-in-depth: SNI/domain allowlist limiting the gateway's own outbound to the provider host (openrouter.ai), noted or implemented.

Done when: gateway starts under its own user, answers an OpenAI-compatible chat completion using the real key, and the real key is readable only by the gateway user.

## Review (sonnet subagent, branch m4-gateway)

**CTO-directed deviation implemented, not LiteLLM.** Per explicit CTO instruction relayed with
this task, built a small custom TypeScript OpenRouter-only proxy instead of LiteLLM, with no
Postgres/DB — in-memory key store only. `PLAN.md` §5 and the milestone-4 bullet, plus the
repository-layout tree and "Defaults chosen" section, were updated to document this deviation
and its rationale (see the `> Implementation deviation` blockquote in §5).

### What was built

New workspace package `packages/gateway` (`@magpie/gateway`), matching `packages/orchestrator`'s
conventions exactly (`node:http`, `zod`, `vitest`, same `tsconfig.json`/`package.json` shape):

- `src/config.ts` — env-based config (`GatewayConfig`/`loadGatewayConfig`), secrets
  `MAGPIE_GATEWAY_OPENROUTER_KEY` / `MAGPIE_GATEWAY_MASTER_KEY` (required), non-secret
  `GATEWAY_PROXY_HOST` (default `127.0.0.1`, rejects `0.0.0.0`), `GATEWAY_PROXY_PORT` (4000),
  `GATEWAY_MGMT_PORT` (4100, host hardcoded to `127.0.0.1` — not env-configurable, by design),
  `GATEWAY_UPSTREAM_BASE_URL` (`https://openrouter.ai/api/v1`), `GATEWAY_DEFAULT_MODEL`.
- `src/keystore.ts` — in-memory `Map`-backed `KeyStore`: `mint`/`revoke`(idempotent)/`findByKey`
  (lazy TTL eviction)/`isOverBudget`/`recordSpend` (clamped, no-op on unknown id).
- `src/upstream.ts` — pure cost-extraction: `determineCost(bodyText, isStream)` prefers real
  `usage.cost` (both JSON and SSE-final-chunk), falls back to token-count estimate, then a flat
  charge — never returns a zero/undefined charge.
- `src/proxy-server.ts` — data plane: `GET /healthz` (unauth), `POST /v1/chat/completions`
  (virtual-key auth, budget check before forwarding, real-key injection, streamed pass-through
  response, per-key model-scope enforcement, post-hoc spend recording only on `upstreamRes.ok`).
- `src/admin-server.ts` — control plane: `POST /admin/keys`, `DELETE /admin/keys/:id`
  (idempotent), master-key auth + loopback-remote-address check (defense-in-depth on top of the
  `127.0.0.1`-only bind).
- `src/http-util.ts` — shared body-reading/JSON-response/bearer-token/loopback helpers.
- `src/index.ts` — composition root (both listeners, SIGINT/SIGTERM shutdown), entrypoint guard
  matching the orchestrator's `index.ts` pattern.
- `packages/gateway/README.md` — run instructions, full env var list, HTTP contract, security
  model, and a step-by-step dedicated-user provisioning recipe.
- `config.example.toml` and root `README.md` updated to point at the gateway's own env vars
  without duplicating them.
- Root `package.json` gained `gateway:dev`/`gateway:build`/`gateway:start` convenience scripts
  (not required for the `--workspaces` verification commands, which pick up
  `packages/gateway/package.json`'s own `build`/`test` scripts automatically).

### Interface as-built (LOCKED CONTRACT — unchanged from the task brief)

- Proxy plane: `GET /healthz`, `POST /v1/chat/completions`, `Authorization: Bearer <virtual key>`,
  401 unknown/expired, 402 over-budget, streams SSE and non-streaming responses through untouched.
- Mgmt plane: `POST /admin/keys` `{model?, budgetUsd, ttlSeconds}` -> `201 {id, key}`;
  `DELETE /admin/keys/:id` -> `204`, idempotent; `Authorization: Bearer <master key>`; loopback-only.
- Key shape: `{ id, key, budgetUsd, spentUsd, model?, expiresAt }`, `sk-magpie-<64 hex>` prefix.
- Defaults: proxy `127.0.0.1:4000`, mgmt `127.0.0.1:4100` (host not configurable), upstream
  `https://openrouter.ai/api/v1`.

### Verification evidence

- `npm run build --workspaces`: clean (gateway + orchestrator + review-extension all build).
- `npm run test --workspaces`: gateway **49/49 passing** (6 test files: config, keystore,
  upstream cost-extraction, http-util, admin-server, proxy-server), orchestrator 163/163,
  review-extension 11/11 — all still green.
- `tsc -p tsconfig.json --noEmit` on `packages/gateway`: clean.
- **Live proof**, dedicated user `magpie-gateway` (created via `useradd --system
  --no-create-home`), real key sourced from repo-root `.env`'s `MAGPIE_LLM_API_KEY` into
  `/etc/magpie-gateway/gateway.env` (mode `600`, owned `magpie-gateway:magpie-gateway`, verified
  unreadable even by the `operator` user running this session — `sudo -u operator cat` on it was
  `Permission denied`). Gateway artifacts deployed to `/opt/magpie-gateway` (world-readable,
  outside any user's home) since `/home/operator` is `700` and would otherwise have blocked the
  gateway user from traversing to the repo's build output; a copy of the `node` binary was placed
  at `/usr/local/bin/node` for the same reason (no system-wide Node install existed).
  - Started under `sudo -u magpie-gateway /usr/local/bin/node dist/index.js`; `ps` confirmed
    `USER=magpie-gateway`.
  - `POST /admin/keys` (master key) minted `sk-magpie-...` keys; used one against **real
    OpenRouter** (`openai/gpt-4o-mini`) via `POST /v1/chat/completions` — got back a real
    completion (`"content":"PONG"`) with real `usage.cost` (`0.00000345`).
  - Repeated for a **streaming** request (`stream:true`) — real SSE chunks passed through live
    (`curl -N`), final chunk carried `usage.cost`, correctly recorded.
  - Budget exhaustion: minted a key with `budgetUsd: 0.000001`; first real call succeeded (200,
    crossing the tiny budget via real spend); second call on the same key -> **402**
    `{"error":{"message":"budget exhausted for this key","type":"budget_exceeded"}}`. Reproduced
    for both non-streaming and streaming.
  - Revocation: `DELETE /admin/keys/:id` -> `204`; repeat delete -> `204` (idempotent); using the
    revoked key afterward -> **401** `{"error":{"message":"invalid or expired API key",...}}`.
    Wrong master key on mgmt calls -> `401`.
  - Non-loopback reachability: `ss -tlnp` showed both listeners bound to `127.0.0.1` only
    (`0.0.0.0:*` NOT present); `curl` to the host's real LAN IP (`192.168.4.225:4100`) failed to
    connect at all (`HTTP 000`) — the OS-level guarantee, not just an app-level check.
  - Secret hygiene: grepped the gateway's full stdout/stderr log and every captured HTTP response
    body for the real key's prefix after every call above — **zero matches** in all cases.
  - Cleaned up: gateway process stopped, temp verification files removed after the run. The
    `magpie-gateway` system user, `/etc/magpie-gateway/gateway.env`, and `/opt/magpie-gateway`
    deployment were left in place as inspectable evidence (a formal systemd unit is M5's job per
    the task brief; this is the "runnable and documented now" proof).

### Things I interpreted (flagging for tech-lead confirmation, not blocking)

1. **Per-key model scoping**: when a key is minted with `model`, the gateway overrides the
   client's requested `model` in the forwarded request (rather than rejecting a mismatch or just
   defaulting when absent). Not explicitly specified in the locked contract; chose "enforce" over
   "hint" since a scoped key that a caller could still redirect to any model isn't really scoped.
   Easy to change if M4-B/C want different semantics.
2. **Cost-parsing fallback constants** (`FALLBACK_COST_PER_1K_TOKENS_USD = 0.01`,
   `FALLBACK_FLAT_CHARGE_USD = 0.01`) are hardcoded in `src/upstream.ts` rather than
   env-configurable — kept the config surface to exactly what the task brief listed. Flag if you
   want these tunable.
3. **Non-streaming responses aren't byte-streamed to the client** the way SSE responses are (the
   gateway awaits the full upstream body via `fetch`, then writes it once) — this is inherent to
   a single JSON response body, not a buffering shortcut; only the *streaming* path has an
   actual "don't wait for the end" guarantee to honor, and that path does forward chunk-by-chunk
   as they arrive from `fetch`'s `ReadableStream`.
4. Did **not** touch M4-B/C/D/E surfaces (no orchestrator mint client, no iptables, no container
   env wiring, no entry-script changes) — only `packages/gateway` + provisioning + `PLAN.md`/
   `config.example.toml`/`README.md` docs, per the task's explicit boundary.

Left `status: in_progress` per instructions — tech lead to review and close.
