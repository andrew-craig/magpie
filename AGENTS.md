# Magpie

Magpie is a self-hosted GitHub code-review bot for a personal Linux server. It listens for
pull request webhooks, checks out the PR branch, runs the [Pi coding agent](https://pi.dev/)
over the diff inside a locked-down container, and posts the findings back to the PR as a
`COMMENT` review with inline comments (it never approves or blocks — humans decide).

**Core security principle — capability separation.** The real threat is *indirect prompt
injection* against the review agent, not execution of PR code. Defenses are structural, not
prompt-based: the agent container holds no secret worth stealing (no GitHub token, no
long-lived LLM key), the host orchestrator does all privileged work (mints tokens, clones,
publishes), and container egress is default-deny through a host-side LiteLLM gateway that is
its only reachable destination. A fully injected agent can at worst emit a garbage review.

**Architecture at a glance:** GitHub App webhook → Cloudflare Tunnel (`cloudflared`,
outbound-only) → host orchestrator (Node/TS, systemd). Per job the orchestrator mints a 1h
installation token, clones the PR checkout credential-free, mints a budget-capped per-job
virtual key on the LiteLLM gateway, runs the hardened `magpie-reviewer` container (read-only
rootfs, `cap-drop=ALL`, no `bash`/`write` tools), parses `findings.json`, publishes the
review, then cleans up. The gateway holds the single real OpenRouter key and enforces
hostname-based egress + hard cost caps.

**Stack:** TypeScript/Node, npm workspaces. `packages/orchestrator` (webhook server, queue,
git ops, docker runner, publisher), `packages/review-extension` (Pi `report_findings` tool +
reviewer prompt), `docker/`, `gateway/`, `scripts/`, `systemd/`.

**Status:** early — Milestone 1 (walking skeleton: webhook → GitHub App auth → clone → run Pi
on host → post summary comment). See `PLAN.md` for the full design, threat model, and the
6-milestone roadmap.

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