# Magpie

Magpie is a self-hosted GitHub code-review bot that any organisation can run on its own Linux
host. It listens for pull request webhooks (and `@magpie review` PR comments), checks out the
PR branch, runs the [Pi coding agent](https://pi.dev/) over the diff inside an isolated
sandbox, and posts findings back to the PR as a `COMMENT` review with inline comments — it
never approves or blocks; a human always decides. See [ARCHITECTURE.md](ARCHITECTURE.md) for
the full design and threat model, [DISTRIBUTION.md](DISTRIBUTION.md) for the self-hosting
architecture, and [HISTORY.md](HISTORY.md) for how the system was built.

**Core security principle — capability separation.** The real threat is *indirect prompt
injection* against the review agent, not execution of PR code. The defenses are structural, not
prompt-based: the agent holds no secret worth stealing (no GitHub token, no long-lived LLM key —
only a short-lived, budget-capped per-job virtual key), the host orchestrator does all
privileged work (mints tokens, clones, publishes), and the reviewer sandbox has no network
egress path in *any* isolation tier — at the shipped default (hardened crun) tier this is
`--network none` with the only channel out a per-job unix socket to a host-side gateway that
holds the real provider key. A ranked, auditable isolation-tier ladder sits on top of that floor
— **micro-VM (KVM, rootless libkrun) > hardened crun (the shipped default/floor)** — resolved at
startup by probing the host, never silently degraded (a downgrade requires an explicit
`MAGPIE_ACK_TIER` operator acknowledgement), and visible only to the operator (`GET /healthz` +
structured logs — never the PR itself). The reviewer-launching substrate is rootless Podman; the
honest TCB claim is *"no root daemon and no root Magpie process; the only setuid-root surface is
two shadow-utils binaries (newuidmap/newgidmap) at namespace setup."*

**Stack:** TypeScript/Node, npm workspaces, plus small native Rust helpers under `rust/`.
`packages/orchestrator` — webhook server, queue, git ops, diff, container/micro-VM reviewer
runner, gateway client, publisher. `packages/review-extension` — the Pi `report_findings` tool.
`packages/gateway` (`@magpie/gateway`) — the host-side credential-injecting LLM proxy.
`docker/reviewer` — the published `magpie-reviewer` image. `rust/magpie-tier-probe` — the
`/dev/kvm` `KVM_CREATE_VM` preflight the isolation-tier ladder shells out to;
`rust/magpie-microvm-launcher` — the rootless-libkrun launcher for the opt-in micro-VM tier.

**Pipeline, in brief:** webhook → HMAC verify → event filter (a `pull_request` action, or an
authorized `@magpie review` comment) → queue → GitHub App auth → credential-free clone →
GitHub-API diff → resolve `.magpie.toml` from the PR's base branch, if present → resolve the
isolation tier this host can actually deliver → mint a per-job gateway virtual key → launch the
reviewer at that tier → parse structured `report_findings` → post one `COMMENT` review with
diff-anchored inline comments (incremental + deduped on re-push) → cleanup (workspace, virtual
key, reviewer sandbox) → record one telemetry entry, regardless of outcome. The resolved tier is
never part of the published review — it surfaces only on `GET /healthz` and in operator logs.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the full breakdown of each stage.

## Where things live

`packages/orchestrator/src/` — `server.ts` (webhook receipt + `/healthz`), `filter.ts` +
`comment-command.ts` (the two review triggers: `pull_request` events and authorized `@magpie
review` comments), `queue.ts`, `github.ts` (App auth), `workspace.ts` (credential-free clone),
`diff.ts`, `repo-config.ts` + `glob-match.ts` (per-repo `.magpie.toml`), `reviewer.ts` +
`tier-ladder.ts` + `microvm-vsock.ts` (isolation-tier resolution and sandbox launch),
`docker.ts` / `container-mounts.ts` / `orphan-cleanup.ts` / `docker-image-config-drift.ts`
(container-runtime plumbing), `gateway.ts` (virtual-key mint/revoke), `findings.ts` +
`anchor.ts` (parse + diff-anchor), `rereview.ts` (incremental dedup + comment minimization),
`publisher.ts`, `pipeline.ts` (wires it all into the `JobRunner` the queue drives),
`telemetry.ts`, `cgroup-preflight.ts`, `shutdown.ts` / `index.ts` (composition root).

`packages/gateway/src/` — the host-side credential-injecting LLM gateway: OpenAI-compatible
proxy plane over a per-job unix socket/vsock channel, loopback-only management plane,
budget-capped virtual keys. See `packages/gateway/README.md`.

`packages/review-extension/src/` — the Pi `report_findings` tool, baked into the reviewer image.

`docker/reviewer/` — the `magpie-reviewer` image, its entrypoint (fail-closed confinement
assertions), and the in-container TCP→unix `forwarder.mjs`.

`rust/` — `magpie-tier-probe` (KVM preflight), `magpie-microvm-launcher` (rootless-libkrun
launcher), `vsock-client` (micro-VM guest-side gateway channel).

`systemd/`, `scripts/install.sh`, `scripts/pack-host.sh` — production units and the release/install
tooling. `docs/` — `ingress.md`, `repo-config.md`, `review-flow.md`, and `design/` (decision
records for major architecture choices).

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
- Track Progress: Mark items complete as you go. Commit chalk task tracking changes to the branch they relate to (see "Closing tasks" below)
- Explain Changes: High-level summary at each step
- Document Results: Add review section to the task file
- Capture Lessons: Update LEARNINGS.md after corrections

Closing tasks

`chalk close <id>` physically MOVES the task file from `.chalk/tasks/<id>.md` to `.chalk/tasks/closed/<id>.md` (and updates `.chalk/task_list.md` plus any dependents' `blocked_by`). Chalk is a LOCAL, file-based tracker with NO connection to GitHub — nothing watches for a PR to merge, so a merge does not close anything by itself.

The convention is therefore: when a task's work goes out as a PR, run `chalk close <id>` ON THAT PR's BRANCH and COMMIT the resulting file move (the delete-from-`tasks/` + add-to-`closed/`, the `task_list.md` change, and any dependent updates) as part of the PR. That way the close is in the PR diff and lands on `main` when — and only when — the PR merges. This is what "closed on merge" means: the close rides along in the branch, it is not triggered by the merge event.

Do NOT leave a merged PR's task `in_progress` expecting it to auto-close, and do NOT close a task on `main` for work that is still an unmerged branch. If you forget to close on the branch, close it manually after merge with a follow-up commit. Note that `chalk close` auto-unblocks dependents the moment it runs, so closing on the branch makes dependents appear unblocked locally before the PR actually merges — usually fine, but be aware of it for CTO-gated PRs.