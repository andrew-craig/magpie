# Magpie — Automated Code Review Bot: Implementation Plan

Magpie is a self-hosted code review bot that runs on a personal Linux server. It listens for
GitHub pull request events, checks out the PR branch, runs the [Pi coding agent](https://pi.dev/)
over the changes inside a locked-down container, and posts the findings back to the PR as a
review with inline comments.

## Confirmed architecture decisions

| Decision | Choice | Rationale |
|---|---|---|
| GitHub auth | **GitHub App** | App-level webhook (configure once, works for every repo the app is installed on), short-lived 1-hour installation tokens, minimal permissions (`contents: read`, `pull requests: read/write`), distinct bot identity on comments. |
| Webhook ingress | **Cloudflare Tunnel** | `cloudflared` makes an outbound-only connection — no open inbound ports, home IP never exposed, free, stable HTTPS URL. Payloads are additionally HMAC-verified (`X-Hub-Signature-256`). |
| Agent sandbox | **Ephemeral Docker container per review + host-level egress allowlist** | Pi has no built-in sandboxing, and PR content must be treated as an active prompt-injection attempt. Each review runs in a fresh hardened container that can only reach the LLM API. |
| Stack | **TypeScript/Node** | Pi is TypeScript and its structured-output extension must be written in TS anyway; `octokit` handles GitHub App auth and webhook verification natively. One language for the whole project. |

## Threat model (why the architecture looks like this)

The realistic attack is not the PR code being executed as part of anything — it's **indirect
prompt injection targeting the review agent itself**. The "Comment and Control" disclosures
(2025–26) demonstrated PR titles/diffs/comments steering Claude Code, Gemini CLI, and Copilot
Agent into running attacker-supplied shell commands and exfiltrating API keys and write-scoped
GitHub tokens — exfiltrating them *through GitHub itself*, so egress filtering alone that
allows GitHub doesn't save you.

Prompt-level defenses cannot be relied on; the fix is **capability separation**:

1. **The agent container holds no secret worth stealing — not even the LLM API key.**
   No GitHub token, no `.git-credentials`, no credential helper, no long-lived LLM key in env.
   The real provider key lives in a host-side gateway; the container authenticates to that
   gateway with a short-lived, budget-capped, per-job virtual key that is worthless to exfiltrate.
2. **The host orchestrator does all privileged work** — it mints installation tokens, clones
   the repo, and posts the review. The agent only ever sees a credential-free checkout and
   emits findings as data.
3. **Network egress from the container is default-deny**, forced through a host-side gateway
   that is the container's *only* reachable destination; the gateway alone can talk to the LLM
   provider. Filtering is by hostname, not IP (see §5 on why IP allowlisting a CDN-fronted API
   is inadequate).
4. Even a fully prompt-injected agent can therefore, at worst, produce a garbage review —
   which a human reads before acting on.

This is the same principle as GitHub's own `pull_request_target` guidance: never let untrusted
PR content execute in a context holding secrets.

## Architecture

```
                     GitHub (App webhook: pull_request events)
                        │ HTTPS
                        ▼
              Cloudflare Tunnel (cloudflared, outbound-only)
                        │ localhost
                        ▼
┌─ Host: magpie orchestrator (Node/TS, systemd service) ──────────────┐
│                                                                     │
│  webhook server ──▶ HMAC verify ──▶ filter events ──▶ job queue     │
│                                                     (p-queue,       │
│                                                      concurrency 2)  │
│  per job:                                                           │
│   1. mint installation token (1h TTL)                               │
│   2. git clone/fetch refs/pull/N/head into /var/lib/magpie/work/…   │
│      (token in URL only on host; checkout handed over cred-free)    │
│   3. mint per-job virtual key on the gateway (budget-capped)        │
│   4. docker run (hardened, isolated bridge net) ──▶ Pi review        │
│   5. parse findings JSON from container output                      │
│   6. POST /repos/…/pulls/N/reviews (inline comments + summary)      │
│   7. cleanup: rm workspace, revoke virtual key, container --rm       │
└─────────────────────────────────────────────────────────────────────┘
          │ docker run
          ▼
┌─ Container: magpie-reviewer ──────────┐                                    openrouter.ai
│  ephemeral · non-root · ro rootfs     │                                        ▲ HTTPS
│  cap-drop=ALL · mem/cpu/pids limits   │   ┌─ gateway (host, own user, TS) ──────┴─┐
│  egress default-deny → gateway is     │   │  holds real OpenRouter key           │
│  the ONLY reachable host              │   │  per-job virtual keys + spend budgets │
│  contents: repo checkout (ro, no .git)│   │  egress allowlist: openrouter.ai only │
│           + Pi + review extension     │   └───────────────────────────────────────┘
│  secret: none long-lived              │              ▲
│  Pi base URL → gateway ───────────────┼──────────────┘  OpenAI-compat API,
│  runs: pi -p --mode json …            │                 per-job virtual key
│  → findings via report_findings       │                 (localhost only)
└───────────────────────────────────────┘
```

## Components

### 1. Webhook receiver

- Small HTTP server (Fastify or plain `node:http`) listening on localhost; `cloudflared`
  routes `https://magpie.<your-domain>/webhook` to it.
- Verify `X-Hub-Signature-256` (HMAC-SHA256 over the raw body with the App's webhook secret,
  constant-time compare) before parsing anything. `@octokit/webhooks` does this for us.
- Act on `pull_request` actions: `opened`, `ready_for_review`, `reopened`, `synchronize`.
  Ignore drafts. Deduplicate: if a job for the same PR is queued but not started, replace it;
  if one is running for an older head SHA, let it finish and queue the newer SHA (or cancel —
  start simple, kill-and-requeue later).
- Useful payload fields: `pull_request.number`, `.head.sha`, `.base.repo.full_name`,
  and for `synchronize` the `before`/`after` SHAs (enables incremental review).

### 2. GitHub App integration

- Register a GitHub App: permissions `contents: read`, `pull requests: read & write`;
  subscribe to `pull_request` events; webhook URL = the tunnel hostname.
- Auth flow via `@octokit/auth-app`: App JWT → `POST /app/installations/{id}/access_tokens`
  → 1-hour installation token. Mint a fresh token per job.
- Clone using the token as HTTP password: `https://x-access-token:<TOKEN>@github.com/owner/repo`.
- Always fetch `refs/pull/{N}/head` from the **base** repo — works identically for fork and
  same-repo PRs, no fork remote needed. Shallow/blobless clone
  (`--filter=blob:none`, then checkout) to keep large repos fast.
- After checkout, **strip credentials** before the container sees the workspace:
  `git remote set-url origin https://github.com/owner/repo` (tokenless) and never write a
  credential helper or `.git-credentials`.

### 3. Job queue

- In-process `p-queue` with concurrency 2 and a hard per-job timeout (default 10 min) that
  `docker kill`s the container and deletes the workspace. A crashed orchestrator loses queued
  jobs — acceptable for personal use since a re-push re-triggers review; move to BullMQ/Redis
  only if durability ever matters.

### 4. Review container

Image `magpie-reviewer`: `node:22-slim` + git + Pi (`@earendil-works/pi-coding-agent`) + our
review extension, built once, updated deliberately (pin versions).

Invocation per job:

```
docker run --rm \
  --name magpie-<jobid> \
  --user reviewer \
  --read-only --tmpfs /tmp \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --memory=4g --cpus=2 --pids-limit=256 \
  --network magpie-net \
  -v <workspace>:/work:ro \
  -v <output-dir>:/out \
  -e OPENAI_BASE_URL=http://gateway:4000 \
  -e OPENAI_API_KEY=<per-job-virtual-key> \
  magpie-reviewer review /work /out/findings.json
```

- **No long-lived provider key in the container.** Pi's provider base URL points at the
  host-side gateway (§5), and the only credential injected is a short-lived per-job
  virtual key the orchestrator mints before the run and revokes on cleanup. Even a fully
  prompt-injected agent has no key worth exfiltrating. (Exact env var names depend on how Pi
  overrides base URL/key — confirm against `pi-ai` provider config; the transparent-proxy
  fallback in §5 needs no in-container key at all.)
- Repo mounted **read-only, with `.git` stripped** so no lazy blob fetch or `git` invocation
  can try to reach `origin` (which egress-blocks anyway); the agent works the plain worktree.
- A separate small writable mount for the findings file.
- Entry script runs Pi headless:
  `pi -p --mode json --no-session --no-extensions -e /opt/magpie/review-extension.js
  --tools read,grep,find,ls --append-system-prompt "$(cat /opt/magpie/reviewer-prompt.md)"`
  with the diff + PR metadata piped as the prompt. Read-only tool allowlist — **no `bash`,
  no `write`/`edit`** — removes the entire "injected shell command" class.
- The orchestrator also parses the NDJSON event stream from stdout for logging/cost telemetry.

### 5. Egress control: credential-injecting LLM gateway (host-side)

The container's only permitted egress destination is a **host-side gateway**, which holds the
real provider key and brokers all LLM traffic. This does three jobs at once — credential
custody, hostname-based egress filtering, and hard cost enforcement — and removes the last
secret from the container.

> **Implementation deviation from the original plan (M4-A, task_eb22).** This section
> originally specified **LiteLLM** as the gateway implementation. The CTO decided **not** to
> adopt LiteLLM and **not** to run Postgres or any database for it: LiteLLM's virtual-key/budget
> features assume a DB-backed deployment for anything beyond the simplest setups, which is much
> more operational surface (a whole extra service + schema + backup story) than a
> single-provider, single-host personal project needs. Instead, magpie implements a **small,
> purpose-built TypeScript proxy** — `packages/gateway` (`@magpie/gateway`) — that speaks only
> to OpenRouter (no generic multi-provider abstraction) and keeps virtual keys in an **in-memory
> `Map`**, matching the orchestrator's existing `node:http` + `zod` conventions rather than
> pulling in a new framework/language/runtime dependency. Losing all keys on a gateway restart
> is an accepted property, not a gap: keys are minted per-job, immediately before a review run,
> and revoked on cleanup, so nothing survives a restart that a re-triggered review wouldn't
> re-mint anyway. Everything else in this section — hostname-based filtering (not IP
> allowlisting), per-job budget-capped virtual keys, the gateway as the container's only
> reachable destination — is unchanged; only the *implementation* of the gateway changed, not
> its role or guarantees.

**Why not an IP allowlist.** The obvious approach (host `iptables`/`ipset` allowing IPs
resolved from `openrouter.ai`) is inadequate: OpenRouter sits behind Cloudflare, whose edge
IPs are shared across millions of domains. Allowlisting those IPs effectively allowlists a huge
slice of the internet, including plausible exfil endpoints — so it does *not* deliver the "can
only reach the LLM API" property the threat model claims. Filtering must be by **hostname/SNI**,
which a gateway (or an SNI-filtering proxy) does natively.

**Gateway (custom TypeScript proxy, `packages/gateway`).**
- Runs on the host as its **own unprivileged user** (`magpie-gateway`), outside the container's
  blast radius, reachable from `magpie-net` only as the configured egress target (nothing else
  on the host).
- Holds the single real OpenRouter key (`MAGPIE_GATEWAY_OPENROUTER_KEY`, gateway-process-only
  env). Exposes an **OpenAI-compatible** endpoint (`POST /v1/chat/completions`, streaming and
  non-streaming); Pi is pointed at it via provider base-URL override, so the container never
  sees the real key.
- **Two planes, two listeners:** a **proxy (data) plane** — the OpenAI-compatible surface plus
  `GET /healthz` — bound to the configurable address the container reaches (never `0.0.0.0`;
  the `magpie-net` gateway IP in production), and a **management (control) plane** —
  `POST /admin/keys` / `DELETE /admin/keys/:id`, master-key-authenticated — bound to
  `127.0.0.1` only, so it is structurally unreachable from `magpie-net` regardless of container
  compromise.
- **Per-job virtual keys:** the orchestrator mints a fresh virtual key (`sk-magpie-...`) before
  each run (optional model scope + USD spend budget + TTL) and revokes it on cleanup. A leaked
  virtual key is short-lived and budget-capped — worthless to steal, which is the point. This is
  also the **hard cost cap** Pi itself lacks (no `--max-turns`/budget flag): the NEXT request on
  a key that has crossed its budget is refused with `402`, regardless of what the agent does.
  Cost is read from OpenRouter's own per-request `usage.cost` (requesting `usage: {include:
  true}` on every forwarded call, including streaming); if that's ever unparseable the gateway
  falls back to a token-based estimate, then a flat per-request charge, so a parsing failure can
  never silently zero out the cap.
- **Upstream egress:** only the gateway process may reach the network, and only to the provider
  host. Enforce with host `iptables` on `magpie-net` (default-deny; the bridge may reach only
  the gateway's listen address) plus, if you want defense-in-depth on the gateway's own
  outbound, an SNI/domain allowlist limiting it to `openrouter.ai` (provider configurable).
- GitHub is deliberately **never** reachable from the container or the gateway — the agent has
  no reason to reach it and GitHub is a proven exfiltration channel.

**Fallback (no base-URL override in Pi).** If Pi can't be pointed at a custom base URL, run a
transparent TLS-terminating egress proxy (e.g. mitmproxy / squid ssl-bump) that the container
trusts via an injected CA, injects `Authorization: Bearer <key>` for `openrouter.ai`, and
denies all other hosts. Same security properties (no in-container key, hostname filtering);
more moving parts (CA distribution, `NODE_EXTRA_CA_CERTS`). Prefer the gateway.

- Dedicated bridge network `magpie-net` with no default forwarding, applied by an idempotent
  `scripts/setup-network.sh` at boot (systemd oneshot). The gateway runs as its own systemd
  service started before the orchestrator.

### 6. Pi review run and structured output

Pi has no shipped JSON-schema output mode (tracked upstream in issue #1086), so we use the
established **tool-call-as-structured-output** pattern, which Pi supports first-class
(`examples/extensions/structured-output.ts`):

- A TypeScript extension defines one tool, `report_findings`, with a strict schema:
  `{ findings: [{ path, line, end_line?, severity: "blocking"|"important"|"nit",
  category, message, suggestion? }], summary: string, verdict: "approve"|"comment" }`.
- The system prompt instructs Pi to explore the checkout as needed (read-only tools), then
  finish by calling `report_findings` exactly once. The tool's `execute()` writes
  `/out/findings.json` and returns `terminate: true`, ending the session immediately.
- If the agent never calls the tool (timeout, refusal, model error), the orchestrator posts a
  short "review failed" comment rather than silence, and logs the session NDJSON for debugging.
- Prompt inputs: the unified diff of the PR (or incremental range), changed-file list, PR
  title/description **clearly delimited as untrusted data**, plus reviewer instructions
  (focus on correctness/security/clarity; no style nitpicking that a linter would catch;
  cite file:line for every finding).
- Cost control: Pi lacks a hard `--max-turns`/cost cap flag today, so enforcement lives
  outside Pi. The **per-job virtual-key budget on the gateway (§5) is the hard cap** —
  the run is cut off at its spend/request limit no matter what the agent does. The
  orchestration layer adds a wall-clock timeout and a diff-size cap (skip or summarize-only
  above ~4k changed lines); NDJSON usage events give post-hoc cost logging.

### 7. Publishing the review

- One API call per review: `POST /repos/{owner}/{repo}/pulls/{N}/reviews` with `event:
  "COMMENT"` (the bot never approves/blocks — humans decide), `body` = summary, and
  `comments[]` = inline findings using `path` + `line`/`side` (+ `start_line` for ranges).
- **Diff-anchoring constraint:** GitHub 422s any comment on a line not present in the diff.
  The orchestrator validates each finding against the parsed diff hunks first; findings that
  don't anchor get folded into the summary body under "Other observations" instead of dropped.
- **Re-review dedup (on `synchronize`):** review only the incremental diff
  (`before...after` from the payload), embed a hidden HTML marker in the summary
  (`<!-- magpie:reviewed:<sha> -->`) to track the last-reviewed commit statelessly from GitHub
  itself, and minimize prior magpie summaries via the GraphQL `minimizeComment` mutation
  (`OUTDATED`) so the PR doesn't fill with stale bot reviews.

## Repository layout

```
magpie/
├── PLAN.md
├── package.json                 # npm workspaces
├── packages/
│   ├── orchestrator/            # webhook server, queue, git ops, docker runner, publisher
│   │   └── src/
│   │       ├── server.ts        # fastify + @octokit/webhooks
│   │       ├── queue.ts         # p-queue wrapper, timeouts, dedup
│   │       ├── github.ts        # app auth, clone, post review, minimize
│   │       ├── workspace.ts     # clone/fetch/cleanup under /var/lib/magpie/work
│   │       ├── runner.ts        # docker run + NDJSON parsing
│   │       └── diff.ts          # hunk parsing, comment anchoring
│   ├── review-extension/        # Pi extension: report_findings tool + reviewer prompt
│   └── gateway/                 # custom TS OpenRouter-only proxy: virtual keys, budgets (M4-A, §5)
├── docker/
│   └── reviewer/Dockerfile      # node + git + pi + extension, pinned versions
├── scripts/
│   ├── setup-network.sh         # magpie-net bridge + iptables: container → gateway only
│   └── install.sh               # systemd units, dirs, cloudflared notes
├── systemd/
│   ├── magpie.service           # orchestrator
│   ├── magpie-gateway.service   # @magpie/gateway (own user, started before orchestrator)
│   └── magpie-firewall.service  # oneshot network setup at boot
└── config.example.toml          # app id, key path, gateway URL, provider/model, limits, repo allowlist
```

## Implementation milestones

1. **Walking skeleton (no sandbox, no tunnel):** webhook server + `smee.io` relay for dev,
   GitHub App auth, clone on PR open, run Pi *directly on the host* against a diff, post a
   single summary comment. Proves the end-to-end loop on a test repo.
2. **Structured findings + inline comments:** review extension with `report_findings`,
   diff-hunk anchoring, single review with inline comments, out-of-diff fallback to summary.
3. **Containerize:** reviewer image, hardened `docker run`, read-only workspace handoff,
   credential stripping, findings via mounted output dir.
4. **Network lockdown + credential-injecting gateway:** stand up the gateway (own user, real
   key; a small custom TypeScript OpenRouter-only proxy — `packages/gateway` — rather than
   LiteLLM/Postgres, see §5's deviation note), point Pi at it via base-URL override, mint/revoke
   a per-job virtual key with a spend budget; `magpie-net` + host iptables so the container can
   reach *only* the gateway. Startup assertion in the entry script: fail closed if any host
   other than the gateway is reachable, and confirm no long-lived provider key is present in the
   container env.
5. **Production hardening:** Cloudflare Tunnel, systemd units, timeouts/concurrency/diff-size
   caps, incremental re-review + comment minimization, cost logging, `synchronize` dedup.
6. **Nice-to-haves (later):** `@magpie review` comment command for on-demand re-review,
   per-repo config file (`.magpie.toml` — read from the *base* branch only, never the PR
   head, to keep config out of attacker control), gVisor runtime, multi-provider support.

## Defaults chosen (easily changed, flag if you disagree)

- **Trigger policy:** auto-review every non-draft PR on `opened`/`ready_for_review`/
  `reopened`/`synchronize`, gated by a repo allowlist in config (don't auto-run on every repo
  the app could be installed on).
- **Review posture:** `COMMENT` only — magpie never approves or requests changes.
- **LLM provider:** OpenRouter with model configurable, reached through a host-side gateway
  (custom TS proxy, `packages/gateway`) that holds the key and enforces per-job budgets
  (container gets only a virtual key).
- **Limits:** concurrency 2, 10-minute job timeout, ~4k-changed-lines diff cap, 4 GB / 2 CPU
  per container.
