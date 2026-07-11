# @magpie/gateway

Host-side, credential-injecting LLM gateway for magpie (Milestone 4, `task_eb22`/M4-A — see
`PLAN.md` §5). This is the **only** place the real OpenRouter API key lives once M4 is fully
wired up: the review container and the orchestrator never see it, only a short-lived,
budget-capped **virtual key** minted per job.

**Implementation note:** `PLAN.md` §5 originally specified LiteLLM. The CTO decided against
LiteLLM and against running Postgres/any database for this; this package is a small, purpose-
built TypeScript proxy instead — OpenRouter-only, in-memory key store, no DB. See `PLAN.md` §5's
deviation note for the full rationale. This package intentionally mirrors
`packages/orchestrator`'s conventions: plain `node:http` (no framework), `zod` for validation,
`vitest` for tests.

## What it is

One process, two independent HTTP listeners:

1. **Proxy (data) plane** — the OpenAI-compatible surface the review container's Pi process
   talks to.
2. **Management (control) plane** — key lifecycle, used only by the host orchestrator (and
   operators). Bound to `127.0.0.1` only, on its own port — structurally unreachable from
   `magpie-net`, so a fully compromised review container can never mint or revoke keys, no
   matter what it can reach on the data plane.

Keys are stored in an in-memory `Map`. There is no database and no persistence across restarts —
this is intentional: keys are minted immediately before a review job and revoked on cleanup, so
losing all keys on a gateway restart just means any job in flight at that moment fails closed
(and, per magpie's own failure handling, gets reported as a failed review rather than silently
hanging).

## Running

```
npm run dev --workspace=@magpie/gateway     # tsx, loads packages/gateway/.env then repo-root .env
npm run build --workspace=@magpie/gateway   # tsc -> dist/
npm run start --workspace=@magpie/gateway   # node dist/index.js, same .env loading
```

Both `dev` and `start` use Node's built-in `--env-file-if-exists` the same way the orchestrator
does — no dotenv dependency. Put secrets in `packages/gateway/.env` (git-ignored, like the
orchestrator's) or the repo-root `.env`.

### Required secrets (this process's OWN environment)

| Env var | Meaning |
|---|---|
| `MAGPIE_GATEWAY_OPENROUTER_KEY` | The real OpenRouter API key. Required. Never logged, never present in any response body this service sends. |
| `MAGPIE_GATEWAY_MASTER_KEY` | Bearer token guarding the management plane (`/admin/*`). Required. Never logged. |

These are namespaced `MAGPIE_GATEWAY_*` (not the orchestrator's `MAGPIE_*`) so it's unambiguous,
even in a shared `.env`, which process a given secret belongs to. **In production, the gateway
runs as its own unprivileged system user (`magpie-gateway`) with its env file readable only by
that user** — see "Provisioning" below. The orchestrator process must never be able to read
`MAGPIE_GATEWAY_OPENROUTER_KEY`.

### Non-secret config (`GATEWAY_*` env vars, all optional — sane dev defaults)

| Env var | Default | Meaning |
|---|---|---|
| `GATEWAY_PROXY_HOST` | `127.0.0.1` | Proxy-plane bind address. **Never** `0.0.0.0` (the loader rejects it). Production binds the `magpie-net` gateway IP (`172.31.99.1`, per PLAN.md) — that wiring is M4-D's job, not this package's; this variable just makes the bind address configurable for it. |
| `GATEWAY_PROXY_PORT` | `4000` | Proxy-plane port. |
| `GATEWAY_MGMT_PORT` | `4100` | Management-plane port. The management-plane **host** is hardcoded to `127.0.0.1` in code (not env-configurable) — see `src/config.ts`'s doc comment on `mgmt.host` for why. |
| `GATEWAY_UPSTREAM_BASE_URL` | `https://openrouter.ai/api/v1` | Upstream OpenRouter API base. Requests are forwarded to `${baseUrl}/chat/completions`. |
| `GATEWAY_DEFAULT_MODEL` | unset | Fallback model applied when a request specifies none AND the virtual key wasn't minted with a model scope. |

## HTTP contract

### Proxy plane

- `GET /healthz` — unauthenticated, always `200 "ok"`. Used by M4-E's gateway-reachable probe.
- `POST /v1/chat/completions` — OpenAI-compatible, streaming (SSE, `stream: true`) and
  non-streaming.
  - Auth: `Authorization: Bearer <virtual key>`. Unknown/expired/revoked key -> `401`
    `{ "error": { "message": "...", "type": "invalid_api_key" } }`.
  - Budget: if the key has already spent >= its budget, `402`
    `{ "error": { "message": "...", "type": "budget_exceeded" } }` — **fails closed, no upstream
    call is made**. This is the hard cost cap: it caps a runaway/looping agent regardless of what
    it does next.
  - On success: the client's `Authorization` is stripped and replaced with the real OpenRouter
    key before forwarding; the upstream response (status, `content-type`, body) is streamed back
    to the client **as it arrives** — the gateway never buffers a full streaming body before
    writing the first byte to the client. Cost is recorded against the key from OpenRouter's
    returned `usage.cost` (the gateway sets `usage: { include: true }` on every forwarded
    request, streaming or not, to get this on both paths) and debited **after** the response
    completes ("post-hoc" — the guarantee is only that the *next* request on an over-budget key
    is refused, not that a single huge request can't complete). If `usage.cost` can't be parsed,
    the gateway falls back to a rough token-count-based estimate, then (if even that's
    unavailable) a small flat per-request charge — see `src/upstream.ts`'s doc comment. **A
    parsing failure never results in a zero charge**, so the cap can't be defeated by a malformed
    or adversarial-looking upstream response.
  - If the key was minted with a `model` scope, the request's `model` field is overridden to
    that value regardless of what the client asked for (enforces the scope rather than just
    hinting at it).
  - Upstream errors (4xx/5xx from OpenRouter) are passed through unchanged and are **not**
    charged against the key's budget.

### Management plane (loopback-only)

- `POST /admin/keys` — mint a virtual key.
  - Auth: `Authorization: Bearer <MAGPIE_GATEWAY_MASTER_KEY>`. Anything else -> `401`.
  - Body: `{ "model"?: string, "budgetUsd": number, "ttlSeconds": number }`.
  - Response: `201 { "id": string, "key": string }`. `key` looks like `sk-magpie-<64 hex chars>`.
- `DELETE /admin/keys/:id` — revoke a virtual key.
  - Auth: same as above.
  - **Idempotent**: revoking an unknown or already-revoked id still returns `204` — never an
    error. The orchestrator's cleanup path calls this unconditionally and must never fail a job
    over a double-revoke race.
- Any other path under this listener -> `404`.
- **Every request on this plane is also checked against the socket's remote address** and
  rejected with `403` if it isn't loopback (`127.0.0.1`/`::1`) — defense-in-depth on top of the
  listener only ever being bound to `127.0.0.1` in the first place. Both checks must hold for the
  "management plane is unreachable from `magpie-net`" guarantee; see `src/admin-server.ts`'s
  module doc comment.

## Security model (summary)

- The real OpenRouter key exists in exactly one place after M4: this process's environment
  (`MAGPIE_GATEWAY_OPENROUTER_KEY`). It's set on the *outbound* request to OpenRouter only,
  never logged, and never appears in any response this service sends (see
  `proxy-server.test.ts`'s "real key never leaks" assertions).
- Virtual keys are short-lived (`ttlSeconds`, enforced on every lookup), budget-capped
  (`budgetUsd`, enforced before every forwarded request), and revocable — a leaked one is worth
  at most its remaining budget for at most its remaining TTL, then nothing.
- The management plane (mint/revoke) is loopback-only by construction (separate `http.Server`,
  bound to `127.0.0.1`) plus a per-request remote-address check — a compromised review container
  on `magpie-net` can reach the data plane but categorically cannot mint or revoke keys.
- **Future hardening (noted, not implemented here):** the gateway's own outbound traffic only
  ever needs to reach `openrouter.ai`. An SNI/domain allowlist on the gateway process's own
  egress (e.g. host `iptables`/`ipset` scoped to the gateway user, or an actual SNI-filtering
  outbound proxy) would add defense-in-depth against the gateway process itself being
  compromised, but is out of scope for M4-A.

## Provisioning as its own unprivileged user

The gateway must run as a dedicated system user, separate from whatever runs the orchestrator,
so a compromise of one process's filesystem access doesn't hand over the other's secrets. Example
(Debian/Ubuntu-style host; adjust paths as needed):

```bash
# 1. Dedicated system user, no login shell, no home directory login.
sudo useradd --system --no-create-home --shell /usr/sbin/nologin magpie-gateway

# 2. Env file holding the two secrets, readable ONLY by that user.
sudo install -d -o magpie-gateway -g magpie-gateway -m 700 /etc/magpie-gateway
sudo install -o magpie-gateway -g magpie-gateway -m 600 /dev/null /etc/magpie-gateway/gateway.env
sudo tee /etc/magpie-gateway/gateway.env > /dev/null <<'EOF'
MAGPIE_GATEWAY_OPENROUTER_KEY=sk-or-...
MAGPIE_GATEWAY_MASTER_KEY=...
GATEWAY_PROXY_HOST=127.0.0.1
EOF
sudo chown magpie-gateway:magpie-gateway /etc/magpie-gateway/gateway.env
sudo chmod 600 /etc/magpie-gateway/gateway.env

# 3. Run under that user (a formal systemd unit lands in M5 — for now, run
#    directly to prove the property):
sudo -u magpie-gateway env $(cat /etc/magpie-gateway/gateway.env | xargs) \
  node /path/to/magpie/packages/gateway/dist/index.js
```

A `systemd` unit (`User=magpie-gateway`, `EnvironmentFile=/etc/magpie-gateway/gateway.env`,
started before `magpie.service`) is the intended production form and is tracked for M5, matching
how `docker/reviewer/README.md` and the orchestrator's own systemd unit are staged — this package
only needs to be runnable and documented now, per the M4-A task contract.
