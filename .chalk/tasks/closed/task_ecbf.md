---
id: task_ecbf
title: M7-4: Config portability — delete pinned IPs/subnet; gateway address becomes a socket path; keep secret split
type: task
status: closed
priority: 2
labels: [distribution]
blocked_by: []
parent: epic_0162
remote_task_url: null
created_at: 2026-07-12T13:07:35Z
updated_at: 2026-07-14T11:27:06Z
---
Remove the pinned network contract from config now that the reviewer has no network (Design D). Delete container_base_url=172.31.99.1:4000 and the container.network setting; the gateway proxy plane address becomes a unix SOCKET PATH (per-job or a fixed dir, e.g. /run/magpie/jobs), not a bridge IP. Remove the 172.31.99.0/24 references from config.example.toml and its comments. Consolidate non-secret config into one clear place, but KEEP the deliberate secret split (webhook secret, gateway master key, real OpenRouter key, GitHub PEM must not all be co-readable) — do NOT collapse all secrets into one file. Document the openssl rand -hex 32 master-key step (shared by orchestrator + gateway).

## Gap analysis (tech-lead, 2026-07-14)

The structural half of this task ALREADY landed as a side effect of M7-1 (Design D
isolation) and M7-3 (host packaging). Verified against the tree:

- [x] Pinned `172.31.99.0/24` / `.1` contract deleted — no literal subnet remains in
      `config.example.toml` or `packages/orchestrator/src/config.ts` (only historical
      "the old magpie-net IP" mentions in explanatory comments).
- [x] `container.network` config field deleted — no `network` field in the orchestrator
      container schema.
- [x] `scripts/setup-network.sh` + `magpie-firewall.service` deleted (M7-1).
- [x] Gateway proxy-plane address is now a unix socket path: `GATEWAY_SOCKET_DIR`
      (default `/run/magpie-gateway/jobs`), one per-job `<jobId>/gw.sock` — see
      `packages/gateway/src/config.ts` + `job-sockets.ts`.
- [x] `container_base_url` is now the in-container loopback `http://127.0.0.1:4000/v1`
      (the TCP→unix forwarder), NOT a bridge IP.
- [x] Secret split intact: `magpie.env` (owner magpie, 0600) vs `gateway.env`
      (owner magpie-gateway, 0700 dir + 0600 file) — the real OpenRouter key lives ONLY
      in gateway.env; the two files are not co-readable.
- [x] Non-secret config already consolidated per service: orchestrator →
      `config.example.toml`; gateway → `packages/gateway/README.md` §"Non-secret config"
      (full `GATEWAY_*` table).

### Remaining deliverable (the only real work)

Document the `openssl rand -hex 32` shared-master-key generation step AT THE SPOTS AN
OPERATOR ACTUALLY FILLS THE KEY. Today it lives only in `INSTALL.md` step 6; add it to:

1. `scripts/install.sh` — the two seeded env-file templates (comment beside each
   `MAGPIE_GATEWAY_MASTER_KEY=` line) and next-steps "step 1".
2. `config.example.toml` — the `MAGPIE_GATEWAY_MASTER_KEY` doc block at the top.

Scope guard: doc-comment additions only. Do NOT touch any code path, schema, default,
systemd unit, or the secret split. Keep wording consistent with the existing INSTALL.md
phrasing ("generate once with `openssl rand -hex 32`; MUST be identical in both files").

### Verification bar

- `npm run build && npm run gateway:build` still clean (no code touched, but prove it).
- `bash -n scripts/install.sh` + `shellcheck scripts/install.sh` clean.
- `grep -rn "172.31.99" config.example.toml packages/*/src/*.ts` returns nothing.
- install.sh NOT executed on this live prod host (read/lint only).

## Review / results (2026-07-14)

Structural half confirmed already-done (see gap analysis above — nothing to change).
Only deliverable was the `openssl rand -hex 32` doc surfacing; implemented by a sonnet
subagent as a doc-comment-only change, tech-lead reviewed line-by-line.

Changed files (doc/comment prose ONLY — no code path, schema, default, unit, or secret
split touched):
- `scripts/install.sh`: added `# Generate it once with: openssl rand -hex 32` beside the
  `MAGPIE_GATEWAY_MASTER_KEY=` line in BOTH seeded env templates (magpie.env and
  gateway.env), and a "Generate the shared master key once with: openssl rand -hex 32"
  line in the next-steps "step 1" output.
- `config.example.toml`: one sentence in the `MAGPIE_GATEWAY_MASTER_KEY` doc block —
  generate once with `openssl rand -hex 32`, SAME value for both env files.

Verification (all clean):
- `bash -n scripts/install.sh` → clean.
- `shellcheck scripts/install.sh` → exit 0, no findings.
- `npm run build && npm run gateway:build` → both succeed.
- `grep -rn "172.31.99" config.example.toml packages/orchestrator/src/config.ts packages/gateway/src/config.ts` → no output.
- install.sh NOT executed; no systemctl / /etc/magpie* / /var/lib/magpie / /etc/systemd/system writes. Prod services untouched.

Secret split preserved: magpie.env (magpie:0600) and gateway.env (magpie-gateway, 0700
dir + 0600 file) remain separate, not co-readable; real OpenRouter key still only in
gateway.env. Non-secret config remains consolidated per service (config.example.toml for
orchestrator; packages/gateway/README.md §Non-secret config for gateway).
