# Magpie — Architecture

Magpie is a self-hosted code review bot that any organisation can stand up on its own Linux
host — a single-host, single-tenant deployment per organisation, not a shared multi-tenant
service. It listens for GitHub pull request activity, checks out the PR branch, runs the
[Pi coding agent](https://pi.dev/) over the diff inside an isolated sandbox, and posts findings
back to the PR as a review with inline comments. It never approves or requests changes — a
human always decides.

This document describes the system as it stands today. For how to install and run it, see
[README.md](README.md), [QUICKSTART.md](QUICKSTART.md), and [INSTALL.md](INSTALL.md). For the
self-hosting/distribution architecture specifically, see [DISTRIBUTION.md](DISTRIBUTION.md).
For how the system got here — the milestone-by-milestone build order and the decisions that
changed along the way — see [HISTORY.md](HISTORY.md).

## Architecture decisions

| Decision | Choice | Rationale |
|---|---|---|
| GitHub auth | **GitHub App** | App-level webhook (configure once, works for every repo the app is installed on), short-lived 1-hour installation tokens, minimal permissions (`contents: read`, `pull requests: read/write`), distinct bot identity on comments. |
| Webhook ingress | **Pluggable** (reverse proxy, Cloudflare Tunnel, or another outbound tunnel — see [docs/ingress.md](docs/ingress.md)) | No inbound ports required for the tunnel options; every option is safe because payloads are HMAC-verified (`X-Hub-Signature-256`) regardless of transport. |
| Agent sandbox | **Ephemeral, per-review sandbox with no network egress path** | Pi has no built-in sandboxing, and PR content must be treated as an active prompt-injection attempt. Each review runs in a fresh, isolated sandbox that can reach nothing but a host-side gateway. |
| Stack | **TypeScript/Node**, with small native Rust helpers | Pi is TypeScript and its structured-output extension must be written in TS anyway; `octokit` handles GitHub App auth and webhook verification natively. Rust is used only where the job requires a native binary (the KVM preflight probe, the micro-VM guest client) that Node can't provide. |

## Threat model

The realistic attack is not the PR code being executed as part of anything — it's **indirect
prompt injection targeting the review agent itself**. Disclosures across 2025–26 demonstrated
PR titles/diffs/comments steering coding agents into running attacker-supplied shell commands
and exfiltrating API keys and write-scoped GitHub tokens — exfiltrating them *through GitHub
itself*, so egress filtering alone that allows GitHub doesn't save you.

Prompt-level defenses cannot be relied on; the fix is **capability separation**:

1. **The agent sandbox holds no secret worth stealing — not even the LLM API key.**
   No GitHub token, no `.git-credentials`, no credential helper, no long-lived LLM key in env.
   The real provider key lives in a host-side gateway; the sandbox authenticates to that
   gateway with a short-lived, budget-capped, per-job virtual key that is worthless to exfiltrate.
2. **The host orchestrator does all privileged work** — it mints installation tokens, clones
   the repo, and posts the review. The agent only ever sees a credential-free checkout and
   emits findings as data.
3. **Network egress from the sandbox is structurally absent, not merely filtered** — the
   reviewer has no network interface at all, in every isolation tier; its only channel out is a
   single per-job connection to the gateway, and only the gateway can reach the LLM provider.
4. Even a fully prompt-injected agent can therefore, at worst, produce a garbage review —
   which a human reads before acting on.

This is the same principle as GitHub's own `pull_request_target` guidance: never let untrusted
PR content execute in a context holding secrets.

## Isolation tiers

The threat model above assumes the reviewer runs inside *some* sandbox. Magpie makes the
strength of that sandbox explicit and **tier-qualified** rather than a single unqualified
claim: at startup it probes the host and selects the strongest of two isolation tiers it can
actually deliver, ranked **micro-VM (KVM) > hardened crun** (see
`docs/design/cto-decision-brief.md` §5 for the full design and rationale, and
`packages/orchestrator/src/tier-ladder.ts` for the implementation):

| Tier | Mechanism | Status |
|---|---|---|
| micro-VM (KVM) | rootless libkrun micro-VM under Podman — a real, separate guest kernel, vsock-only gateway channel | opt-in (needs `/dev/kvm` + `[microvm]` config — see `INSTALL.md`) |
| hardened crun (the floor) | rootless Podman + crun — `--cap-drop=ALL`, `--read-only`, `--network none`, pids/mem caps, `.git`-stripped read-only `/work` | **the shipped default** |

**No unqualified isolation claims.** A statement like "Magpie sandboxes the reviewer in a
micro-VM" is only ever true for a host that has deliberately opted into that tier. **The
default, out-of-the-box tier every install ships with is the hardened crun floor.** The
micro-VM tier is a strictly-stronger opt-in an operator provisions deliberately; Magpie never
silently represents floor-tier isolation as micro-VM-grade.

**Floor invariant.** The crun tier is *defined* to be exactly today's shipped hardened posture,
byte-for-byte — not merely documented as such. `packages/orchestrator/src/reviewer-crun-floor-argv.test.ts`
pins the full container-runtime argv against a committed golden fixture, so the floor cannot
silently erode while attention is on the micro-VM path.

**The one tier-invariant property: no network.** Every tier — floor or micro-VM — runs the
reviewer with no network egress path; only the *depth* of the reviewer↔host-kernel boundary
varies. At the crun floor this is `--network none` (no interfaces but loopback). At the
micro-VM tier the guest is built with no network transport and this is preflight-asserted
fail-closed (no virtio-net device, no TSI/passt socket passthrough — see reviewer.ts's
`findMicrovmNetworkTransportViolations`). This is the single isolation property that never
varies by tier.

**Tier visibility is operator-only.** Which tier actually launched a given job is visible on
`GET /healthz` and in the orchestrator's structured logs — **never** in the PR review body or
comments (enforced by publisher.ts's tier-silence guard test). A prospective attacker must not
be able to learn, from the PR itself, whether a target deployment runs the weaker crun floor
rather than the micro-VM tier before deciding whether an escape is worth attempting.

**Trusted computing base.** The reviewer-launching substrate is rootless Podman: *"no root
daemon and no root Magpie process; the only setuid-root surface is two shadow-utils binaries
(newuidmap/newgidmap) at namespace setup."* Those two binaries are exactly what elevate to
write the container's uid/gid map during rootless namespace setup — which is also why several
of the orchestrator's own systemd seccomp directives (`SystemCallFilter`,
`RestrictAddressFamilies`, `RestrictSUIDSGID`, `LockPersonality`, most `Protect*` — see
`systemd/magpie.service`'s header comment) are deliberately relaxed: each of those forces
`NoNewPrivileges=1`, which blocks `newuidmap`/`newgidmap` from elevating and breaks every
rootless review launch. The compensating argument: the orchestrator is *trusted* host code
whose only job is to launch the sandbox around *untrusted* PR content — the confinement that
matters lives in the reviewer container/micro-VM guest, not in the orchestrator's own seccomp
profile. What the orchestrator unit keeps: `RestrictNamespaces` (narrowed to an explicit
allow-list; verified not to force `NoNewPrivileges`), `ProtectSystem=strict`, `PrivateTmp`, and
`StateDirectory` confinement.

## System overview

```
                    GitHub (App: pull_request + issue_comment webhooks)
                              │ HTTPS, HMAC-signed
                              ▼
                pluggable ingress — reverse proxy / Cloudflare
                Tunnel / other outbound tunnel (docs/ingress.md)
                              │ loopback only
                              ▼
┌─ Host: magpie orchestrator (Node/TS, systemd service, `magpie` user) ─────────────┐
│                                                                                    │
│  webhook server ─▶ HMAC verify ─▶ pull_request filter, or "@magpie review"        │
│                                    PR-comment command ─▶ job queue                │
│  per job:                                                                         │
│   1. mint a GitHub App installation token (1h TTL, one per job)                   │
│   2. credential-free clone of refs/pull/N/head                                    │
│   3. fetch the diff; resolve .magpie.toml from the PR's base branch, if present   │
│   4. mint a per-job virtual key on the gateway (budget-capped)                    │
│   5. launch the reviewer at the isolation tier resolved at startup                │
│   6. parse findings, anchor them to diff hunks                                    │
│   7. publish one COMMENT review (inline comments + summary)                       │
│   8. cleanup: remove workspace, revoke virtual key, reap the sandbox              │
│   9. record one telemetry entry, regardless of outcome                           │
└────────────────────────────────────────────────────────────────────────────────────┘
          │ launches, at the tier resolved for this host
          ▼
┌─ crun floor (shipped default) ────────┐      ┌─ micro-VM (opt-in, needs /dev/kvm) ──┐
│ rootless Podman, --network none       │  or  │ rootless libkrun micro-VM, separate   │
│ cap-drop=ALL, read-only, non-root     │      │ guest kernel, no virtio-net device     │
│ .git-stripped read-only /work         │      │ read-only virtiofs /work               │
│ only egress: a bind-mounted per-job   │      │ only egress: a per-job vsock channel   │
│ unix socket to the gateway            │      │ to the gateway                         │
└──────────────────────────────────────────┘      └───────────────────────────────────────┘
          │ Pi reviews the diff — read-only tool allowlist, no bash, no write
          ▼
   report_findings tool call → findings file → read back by the orchestrator

┌─ gateway (host, own unprivileged user, TS) ───────────────────────────────────────┐
│  holds the one real LLM provider key — the reviewer sandbox never holds it        │
│  proxy plane: per-job socket/vsock channel, the sandbox's only reachable host     │
│  mgmt plane: loopback-only; mints/revokes per-job virtual keys with USD budgets   │
└────────────────────────────────────────────────────────────────────────────────────┘
                              │ HTTPS
                              ▼
                        LLM provider (OpenRouter)
```

## Components

### Webhook ingestion and review triggers

A small HTTP server (`server.ts`, plain `node:http` + `@octokit/webhooks`) listens on
localhost; the configured ingress option routes the public webhook URL to it. Every delivery's
`X-Hub-Signature-256` is verified (HMAC-SHA256 over the raw body, constant-time compare)
*before* the payload is parsed at all.

Two kinds of verified delivery become a review job:

- **`pull_request` events** (`opened`, `ready_for_review`, `reopened`, `synchronize`) — drafts
  are ignored, and the base repo must be on the configured allowlist.
- **`@magpie review` PR comments** — an `issue_comment` delivery whose body matches the
  command. Because the comment body is attacker-controlled (any PR participant, including a
  malicious PR author, can post the literal string), authorization never keys off body content:
  it keys only on the commenter's login, cross-checked live against
  `repos.getCollaboratorPermissionLevel` (not trusted from the webhook payload alone, since
  permissions can change between when a comment was posted and when it's processed). Only
  `write`/`admin` permission triggers a review; anything else — including an API error resolving
  permission — is silently dropped.

Both feed the same bounded-concurrency job queue (per-PR dedup, a hard per-job wall-clock
timeout backstop).

### Job pipeline

For each queued job: mint one fresh GitHub App installation token and reuse it for every
GitHub API call the job makes; clone `refs/pull/{N}/head` into a credential-free workspace (the
token reaches `git` only via an ephemeral env-backed credential helper, never argv or disk, and
`origin` is rewritten tokenless before the checkout is used); compute the diff (the incremental
`before...after` range on a clean-fast-forward `synchronize`, otherwise the full PR diff,
size-capped before the body is fetched).

An allowlisted repo can commit a `.magpie.toml` to its own default branch to tune a small,
pre-approved slice of review behaviour — model (from a server-side allowlist), diff-size cap,
extra reviewer guidance, glob-pattern `ignore_paths`. This file is read **only** from the base
repo's default branch, never the PR head and never a PR-supplied base ref, so a PR cannot use
its own config to influence how it gets reviewed. See [docs/repo-config.md](docs/repo-config.md).

### Review sandbox

The reviewer runs at whichever isolation tier was resolved for this host (see "Isolation
tiers" above) with a read-only tool allowlist (`read`, `grep`, `find`, `ls` — no `bash`, no
`write`/`edit`) and the only secret it's given: this job's gateway virtual key. It runs Pi
headless against the diff and PR metadata (clearly delimited as untrusted data), instructed to
finish by calling the `report_findings` tool exactly once — a strict schema (`{ findings: [{
path, line, severity, category, message, suggestion? }], summary, verdict }`) baked into the
reviewer image via `packages/review-extension`. If the agent never calls the tool, the
orchestrator posts a "review failed" comment rather than staying silent.

### Findings and publishing

Findings are re-validated at the trust boundary before the orchestrator ever relies on them,
then anchored to diff hunks — GitHub rejects any inline comment on a line not present in the
diff, so findings that don't anchor fold into the summary under "Other observations" instead of
being dropped. Exactly one `pulls.createReview` (`event: COMMENT` — Magpie never approves or
blocks) is posted per job, with inline comments plus a summary.

On a `synchronize` push, only the incremental diff is reviewed; a hidden HTML marker in the
summary (`<!-- magpie:reviewed:<sha> -->`) tracks the last-reviewed commit statelessly straight
from GitHub (no local database), and prior Magpie summaries are minimized (`OUTDATED`) so a
long-lived PR doesn't accumulate stale bot reviews.

### Gateway

The reviewer's only permitted egress destination is a **host-side gateway**
(`packages/gateway`), which holds the real provider key and brokers all LLM traffic. It runs as
its own unprivileged user, outside the sandbox's blast radius, and exposes two separate planes:
a **proxy plane** (the OpenAI-compatible surface, reached over the per-job socket/vsock channel
described above) and a **management plane** (mint/revoke, bound to loopback only, so it's
structurally unreachable from the sandbox regardless of compromise).

Filtering is by hostname, not IP: providers commonly sit behind a shared CDN edge, so an IP
allowlist would effectively allowlist a huge slice of the internet rather than "only the LLM
API." A gateway (or equivalent SNI-filtering proxy) filters by hostname natively.

The orchestrator mints a fresh virtual key before each run — model scope, USD spend budget, TTL
— and revokes it on cleanup. A leaked virtual key is short-lived and budget-capped, worthless to
steal. The budget is also the **hard cost cap** Pi itself lacks: the next request on a key that
has crossed its budget is refused with `402`, regardless of what the agent does. GitHub is
deliberately never reachable from the sandbox or the gateway.

### Operability

Every job — success, dedup skip, force-push skip, timeout, abort, or a thrown error — writes
exactly one durable, greppable telemetry record (outcome, cost, duration, usage), logged as
structured JSON and appended to a JSONL file. `GET /healthz` reports the resolved isolation tier
and probe evidence for the operator; the process drains in-flight jobs on `SIGINT`/`SIGTERM`
before exiting.

## Repository layout

```
magpie/
├── ARCHITECTURE.md, DISTRIBUTION.md, HISTORY.md, README.md, QUICKSTART.md, INSTALL.md
├── package.json                     # npm workspaces
├── packages/
│   ├── orchestrator/src/            # webhook server, queue, git ops, diff, review triggers,
│   │                                 # tier ladder, sandbox launch, gateway client, publisher
│   ├── review-extension/src/        # Pi extension: the report_findings tool
│   └── gateway/                     # credential-injecting LLM proxy: virtual keys, budgets
├── rust/
│   ├── magpie-tier-probe/           # /dev/kvm KVM_CREATE_VM preflight
│   ├── magpie-microvm-launcher/     # rootless-libkrun launcher for the micro-VM tier
│   └── vsock-client/                 # micro-VM guest-side gateway channel
├── docker/reviewer/                 # magpie-reviewer image: Dockerfile, entrypoint, forwarder
├── scripts/                         # install.sh, pack-host.sh, dev/test helpers
├── systemd/                         # magpie.service, magpie-gateway.service
├── docs/                            # ingress, repo-config, review-flow, design decision records
└── config.example.toml              # app id, key path, gateway URL, provider/model, limits
```

## Defaults

- **Trigger policy:** auto-review every non-draft PR on `opened`/`ready_for_review`/
  `reopened`/`synchronize`, plus on-demand via `@magpie review`, gated by a repo allowlist in
  config (Magpie doesn't auto-run on every repo the App could be installed on).
- **Review posture:** `COMMENT` only — Magpie never approves or requests changes.
- **LLM provider:** OpenRouter, model configurable, reached through the host-side gateway,
  which holds the key and enforces per-job budgets (the sandbox gets only a virtual key).
- **Limits:** concurrency 2, 10-minute job timeout, ~4k-changed-lines diff cap, 4 GB / 2 CPU
  per reviewer sandbox.
