# Magpie

Magpie is a self-hosted GitHub code-review bot for a personal Linux server. It listens for
pull request webhooks, checks out the PR branch, runs the [Pi coding agent](https://pi.dev/)
over the diff, and posts findings back to the PR as a `COMMENT` review (it never approves or
blocks — humans decide). See `PLAN.md` for the full design, threat model, and the
6-milestone roadmap — this file only tracks what's actually implemented.

**Core security principle — capability separation (target design).** The real threat is
*indirect prompt injection* against the review agent, not execution of PR code. The intended
defenses are structural, not prompt-based: the agent holds no secret worth stealing (no
GitHub token, no long-lived LLM key), the host orchestrator does all privileged work (mints
tokens, clones, publishes), and container egress will be default-deny through a host-side
LiteLLM gateway. Milestone 1 (below) already delivers the "orchestrator does all privileged
work, reviewer gets no secrets" half of this; container isolation and gateway egress lockdown
are planned (M3/M4), not yet built.

**Stack:** TypeScript/Node, npm workspaces. `packages/orchestrator` — webhook server, queue,
git ops, diff, host Pi runner, publisher (implemented, see below). `packages/review-extension`
(Pi `report_findings` tool), `docker/`, `gateway/` — planned, not present yet (M2–M4).

**Status:** Milestone 1 (walking skeleton) is implemented and works end-to-end: webhook →
GitHub App auth → credential-free clone → GitHub-API diff → Pi run as a host subprocess → one
summary PR comment → workspace cleanup. PR #20 (`pipeline-race-hardening`) additionally closed
two follow-on races (queue-vs-review timeout ordering, and a checkout/diff head-SHA mismatch
window). See `PLAN.md` for the full 6-milestone roadmap and what M2–M6 add.

## Implemented so far (Milestone 1)

`packages/orchestrator/src/`:

- `config.ts` — loads/validates `config.toml` plus `MAGPIE_*` env secrets (webhook secret, LLM key, GitHub App private key).
- `server.ts` — `node:http` + `@octokit/webhooks`; verifies `X-Hub-Signature-256` before any payload parsing; also serves `/healthz`.
- `filter.ts` — accepts only `opened`/`ready_for_review`/`reopened`/`synchronize`, drops drafts, gates on `config.repoAllowlist`.
- `queue.ts` — in-process bounded-concurrency queue (`p-queue`), per-PR dedup, hard per-job wall-clock timeout backstop via `AbortController`.
- `github.ts` — mints a fresh 1h GitHub App installation token per job (`@octokit/auth-app`); never cached across jobs.
- `workspace.ts` — blobless clone of `refs/pull/{N}/head` from the base repo; the token reaches `git` only via an ephemeral env-backed credential helper (never argv/disk), and `origin` is rewritten tokenless before the checkout is used.
- `diff.ts` — PR diff sourced from the GitHub API (`pulls.get` diff media type), size-capped by `config.limits.maxDiffLines` before the diff body is ever fetched.
- `reviewer.ts` — runs Pi as a **plain host subprocess** (no container yet) with a read-only tool allowlist (`read,grep,find,ls`; no `bash`/`write`); strips all `MAGPIE_*` secrets from its env; parses NDJSON output into a summary + usage.
- `publisher.ts` — posts exactly one `issues.createComment` per job (marker + usage footer on success, a clear failure note otherwise).
- `pipeline.ts` — wires auth → workspace → diff → head-SHA-mismatch guard → review → publish → cleanup into the single `JobRunner` the queue drives.
- `shutdown.ts` / `index.ts` — composition root; drains in-flight jobs on `SIGINT`/`SIGTERM` before exit.

Also implemented: `reviewer-prompt.md` (reviewer system prompt with untrusted-input handling) and a working Cloudflare Tunnel ingress path (`cloudflared/`, `scripts/setup-cloudflared.sh`, `systemd/cloudflared.service`) — pulled forward from M5 to get a real webhook ingress in place.

**Planned (M2–M6):** structured `report_findings` output + diff-anchored inline comments (M2); containerized, hardened `magpie-reviewer` runtime (M3); LiteLLM gateway with per-job virtual keys and egress lockdown (M4); systemd production hardening, incremental re-review/comment minimization (M5); on-demand `@magpie review`, per-repo config, gVisor, multi-provider support (M6). See `PLAN.md` for details.

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

Setup tracking: If there is not an existing task, create one with chalk create
Plan First: Write plan to the task file with checkable items
Verify Plan: Check in before starting implementation
Create a branch: Put all code fixes into a new branch so they can be tracked and merged
Track Progress: Mark items complete as you go
Explain Changes: High-level summary at each step
Document Results: Add review section to the task file
Capture Lessons: Update LEARNINGS.md after corrections