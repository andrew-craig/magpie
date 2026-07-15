# Magpie

Magpie is a self-hosted GitHub code-review bot that any organisation can run on its own
Linux host. It listens for
pull request webhooks, checks out the PR branch, runs the [Pi coding agent](https://pi.dev/)
over the diff inside a locked-down container, and posts findings back to the PR as a `COMMENT`
review with inline comments (it never approves or blocks — humans decide). See `PLAN.md` for
the full design, threat model, and the 7-milestone roadmap, and `DISTRIBUTION.md` for the
self-hosting architecture — this file only tracks what's actually implemented.

**Core security principle — capability separation (delivered).** The real threat is
*indirect prompt injection* against the review agent, not execution of PR code. The defenses
are structural, not prompt-based: the agent holds no secret worth stealing (no GitHub token,
no long-lived LLM key — only a short-lived, budget-capped per-job virtual key), the host
orchestrator does all privileged work (mints tokens, clones, publishes), and the reviewer
container runs `--network none` with its only channel out being a per-job unix socket to a
host-side gateway that holds the real provider key. All three legs are now built (M1 delivered
the orchestrator/no-secrets split; M3 containerized the reviewer; M4 added the gateway; M7's
"Design D" made the egress isolation provable and config-independent).

**Stack:** TypeScript/Node, npm workspaces. `packages/orchestrator` — webhook server, queue,
git ops, diff, docker reviewer runner, gateway client, publisher. `packages/review-extension`
— the Pi `report_findings` tool. `packages/gateway` (`@magpie/gateway`) — the host-side
credential-injecting LLM proxy. `docker/reviewer` — the published `magpie-reviewer` image.
All present and implemented (see below).

**Status:** Milestones 1–7 are implemented and merged; Magpie works end-to-end and is
self-hostable. The pipeline is: webhook → HMAC verify → event/allowlist filter → queue →
GitHub App auth → credential-free clone → GitHub-API diff → mint per-job gateway virtual key →
`docker run` the `--network none` reviewer container (Pi over the diff, reaching the gateway
only via a bind-mounted unix socket) → parse structured `report_findings` → post one `COMMENT`
review with diff-anchored inline comments (incremental + deduped on re-push) → cleanup
(workspace, virtual key, container). Remaining open work is the M6 nice-to-haves and M5-D cost
logging — see `PLAN.md` and `chalk ready`.

## Implemented so far (Milestones 1–7)

`packages/orchestrator/src/`:

- `config.ts` — loads/validates `config.toml` plus `MAGPIE_*` env secrets (webhook secret, GitHub App private key, gateway master key). No real LLM key here as of M4 — the orchestrator only ever holds the gateway master key.
- `server.ts` — `node:http` + `@octokit/webhooks`; verifies `X-Hub-Signature-256` before any payload parsing; also serves `/healthz`.
- `filter.ts` — accepts only `opened`/`ready_for_review`/`reopened`/`synchronize`, drops drafts, gates on `config.repoAllowlist`.
- `queue.ts` — in-process bounded-concurrency queue (`p-queue`), per-PR dedup, hard per-job wall-clock timeout backstop via `AbortController`.
- `github.ts` — mints a fresh 1h GitHub App installation token per job (`@octokit/auth-app`); never cached across jobs.
- `workspace.ts` — blobless clone of `refs/pull/{N}/head` from the base repo; the token reaches `git` only via an ephemeral env-backed credential helper (never argv/disk), and `origin` is rewritten tokenless before the checkout is used.
- `diff.ts` — PR diff sourced from the GitHub API (`pulls.get` diff media type), size-capped by `config.limits.maxDiffLines` before the diff body is ever fetched.
- `reviewer.ts` — runs Pi via `docker run` of the hardened, `--network none` `magpie-reviewer` container (`--cap-drop=ALL`, `--read-only`, non-root, mem/cpu/pids limits, `.git`-stripped read-only `/work`); read-only tool allowlist (`read,grep,find,ls`; no `bash`/`write`); injects only the per-job gateway virtual key; parses NDJSON output into a summary + usage. (M1/M2 ran Pi as a host subprocess; M3 containerized it, M7 removed its network.)
- `docker.ts` / `container-mounts.ts` / `orphan-cleanup.ts` — docker CLI wrapper, bind-mount assembly (read-only `/work`, per-job gateway socket dir), and reaping of orphaned review containers.
- `gateway.ts` — mints a budget-capped, short-lived per-job virtual key on the gateway's management plane before each run and revokes it on cleanup (`packages/gateway`).
- `findings.ts` / `anchor.ts` — parse/validate the reviewer's structured `report_findings` output and anchor each finding to a diff hunk; out-of-diff findings fold into the summary body rather than being dropped.
- `rereview.ts` — incremental re-review on `synchronize` (review only `before...after`), hidden `<!-- magpie:reviewed:<sha> -->` marker to track last-reviewed commit statelessly, and `minimizeComment` of prior magpie summaries.
- `publisher.ts` — posts exactly one `pulls.createReview` (`event: COMMENT`) per job with inline comments + summary (a clear failure note otherwise).
- `pipeline.ts` — wires auth → workspace → diff → head-SHA-mismatch guard → mint key → containerized review → publish → cleanup into the single `JobRunner` the queue drives.
- `shutdown.ts` / `index.ts` — composition root; drains in-flight jobs on `SIGINT`/`SIGTERM` before exit.

`packages/gateway/src/` — the host-side credential-injecting LLM gateway (own unprivileged user): OpenAI-compatible proxy plane served over a per-job unix socket, loopback-only management plane for mint/revoke, in-memory virtual keys with per-job USD budgets (the hard cost cap Pi lacks). See `packages/gateway/README.md`.

`packages/review-extension/src/` — the Pi `report_findings` tool (strict findings schema, `terminate: true`), baked into the reviewer image.

`docker/reviewer/` — the `magpie-reviewer` image (published multi-arch + cosign-signed to GHCR, digest-pinned in `config.example.toml`), its entrypoint (fail-closed confinement assertions), and the in-container TCP→unix `forwarder.mjs`.

Also implemented: `reviewer-prompt.md` (reviewer system prompt with untrusted-input handling); production systemd units (`systemd/magpie.service`, `systemd/magpie-gateway.service`, `systemd/cloudflared.service`) + `scripts/install.sh`; a versioned host-service release tarball (`scripts/pack-host.sh` + release CI); pluggable webhook ingress (`docs/ingress.md`: reverse proxy, Cloudflare Tunnel, other tunnels); and onboarding docs (`QUICKSTART.md`, `INSTALL.md`).

**Remaining open work:** M5-D cost logging (`task_8a10`); the M6 nice-to-haves — `@magpie review` on-demand command (`task_ad15`), per-repo `.magpie.toml` (`task_220f`), gVisor runtime (`task_624d`), multi-provider support (`task_9c9d`); and M6-E rootless docker path (`task_edbd`). Run `chalk ready` for the current queue.

## Task Tracking

ALWAYS use the chalk CLI tool for ALL task operations.


chalk ready                          # First command when picking up work — shows unblocked tasks by priority
chalk ready --parent=epic_0c4d       # Find available work under a specific epic
chalk show <id>                      # View full task details
chalk list --status=open             # List tasks with filters
chalk update <id> --status=in_progress  # Claim a task
chalk close <id>                     # Mark done (auto-unblocks dependents)
chalk create "Title" --parent=<id>   # Create sub-task

If you have attempted to use chalk and it is not available, tasks can be read manually. Tasks are stored as markdown files with YAML frontmatter at .chalk/tasks/<type>_<hex>.md (e.g. tasks/bug_5cc8.md). Closed tasks move to .chalk/tasks/closed/.

Workflow

- Setup tracking: If there is not an existing task, create one with chalk create
- Plan First: Write plan to the task file with checkable items
- Verify Plan: Check in before starting implementation
- Create a branch: Put all code fixes into a new branch so they can be tracked and merged
- Track Progress: Mark items complete as you go. Commit chalk task tracking changes to the branch they relate to (so they will be marked as closed on merge)
- Explain Changes: High-level summary at each step
- Document Results: Add review section to the task file
- Capture Lessons: Update LEARNINGS.md after corrections