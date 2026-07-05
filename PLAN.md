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

1. **The agent container holds nothing worth stealing except the LLM API key.**
   No GitHub token, no `.git-credentials`, no credential helper, no secrets in env.
2. **The host orchestrator does all privileged work** — it mints installation tokens, clones
   the repo, and posts the review. The agent only ever sees a credential-free checkout and
   emits findings as data.
3. **Network egress from the container is default-deny**, allowlisted to the LLM API endpoint
   only (pattern taken from Claude Code's own `.devcontainer/init-firewall.sh`).
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
│                                                     (p-queue,      │
│                                                      concurrency 2)│
│  per job:                                                          │
│   1. mint installation token (1h TTL)                              │
│   2. git clone/fetch refs/pull/N/head into /var/lib/magpie/work/…  │
│      (token in URL only on host; checkout handed over cred-free)   │
│   3. docker run (hardened, isolated bridge net) ──▶ Pi review      │
│   4. parse findings JSON from container output                     │
│   5. POST /repos/…/pulls/N/reviews (inline comments + summary)     │
│   6. cleanup: rm workspace, container auto-removed (--rm)          │
└─────────────────────────────────────────────────────────────────────┘
                        │ docker run
                        ▼
┌─ Container: magpie-reviewer (ephemeral, per job) ────────────────────┐
│  non-root · read-only rootfs · cap-drop=ALL · mem/cpu/pids limits   │
│  isolated bridge network → host iptables allows LLM API only        │
│  contents: repo checkout (ro) + Pi + review extension               │
│  secret: LLM API key only                                           │
│  runs: pi -p --mode json --no-session … → findings via tool call    │
└─────────────────────────────────────────────────────────────────────┘
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
  -e ANTHROPIC_API_KEY \
  magpie-reviewer review /work /out/findings.json
```

- Repo mounted **read-only**; a separate small writable mount for the findings file.
- Entry script runs Pi headless:
  `pi -p --mode json --no-session --no-extensions -e /opt/magpie/review-extension.js
  --tools read,grep,find,ls --append-system-prompt "$(cat /opt/magpie/reviewer-prompt.md)"`
  with the diff + PR metadata piped as the prompt. Read-only tool allowlist — **no `bash`,
  no `write`/`edit`** — removes the entire "injected shell command" class.
- The orchestrator also parses the NDJSON event stream from stdout for logging/cost telemetry.

### 5. Egress allowlist (host-side)

- Dedicated bridge network `magpie-net` with no default forwarding.
- Host `iptables` + `ipset`: allow DNS + established/related; allow destination IPs resolved
  from the LLM API host (`api.anthropic.com` initially — provider configurable, allowlist
  derived from config); drop everything else from that bridge. Adapted from Anthropic's
  `init-firewall.sh`, but applied **on the host** so the container needs no `NET_ADMIN` and a
  compromised agent can't touch its own firewall.
- Note GitHub is deliberately **not** allowlisted — the agent has no reason to reach it, and
  GitHub is a proven exfiltration channel.
- Applied by an idempotent `scripts/setup-network.sh` run at boot (systemd oneshot), with
  periodic re-resolution of the API host IPs.

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
- Cost control: Pi lacks a hard `--max-turns`/cost cap flag today, so the orchestration layer
  is the enforcement point — wall-clock timeout, diff-size cap (skip or summarize-only above
  ~4k changed lines), and post-hoc cost logging from the NDJSON usage events.

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
│   └── review-extension/        # Pi extension: report_findings tool + reviewer prompt
├── docker/
│   └── reviewer/Dockerfile      # node + git + pi + extension, pinned versions
├── scripts/
│   ├── setup-network.sh         # magpie-net bridge + iptables/ipset egress allowlist
│   └── install.sh               # systemd units, dirs, cloudflared notes
├── systemd/
│   ├── magpie.service           # orchestrator
│   └── magpie-firewall.service  # oneshot network setup at boot
└── config.example.toml          # app id, key path, provider/model, limits, repo allowlist
```

## Implementation milestones

1. **Walking skeleton (no sandbox, no tunnel):** webhook server + `smee.io` relay for dev,
   GitHub App auth, clone on PR open, run Pi *directly on the host* against a diff, post a
   single summary comment. Proves the end-to-end loop on a test repo.
2. **Structured findings + inline comments:** review extension with `report_findings`,
   diff-hunk anchoring, single review with inline comments, out-of-diff fallback to summary.
3. **Containerize:** reviewer image, hardened `docker run`, read-only workspace handoff,
   credential stripping, findings via mounted output dir.
4. **Network lockdown:** `magpie-net` + host iptables/ipset allowlist; verify from inside the
   container that only the LLM API is reachable (automated check in the entry script).
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
- **LLM provider:** Anthropic via `ANTHROPIC_API_KEY` to start; provider/model configurable
  (Pi supports 20+ providers), with the egress allowlist derived from the configured provider.
- **Limits:** concurrency 2, 10-minute job timeout, ~4k-changed-lines diff cap, 4 GB / 2 CPU
  per container.
