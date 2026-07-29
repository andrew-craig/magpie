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
sandbox has no network egress path in *every* isolation tier — at the shipped default (hardened
crun) tier this is `--network none` with the only channel out a per-job unix socket to a
host-side gateway that holds the real provider key. All three legs are now built (M1 delivered
the orchestrator/no-secrets split; M3 containerized the reviewer; M4 added the gateway; M7's
"Design D" made the egress isolation provable and config-independent). M8 layers a ranked,
auditable isolation-tier ladder on top of that floor — **micro-VM (KVM, rootless libkrun) >
gVisor (deferred, `task_624d`) > hardened crun (the shipped default/floor)** — resolved at
startup by probing the host, never silently degraded (a downgrade requires an explicit
`MAGPIE_ACK_TIER` operator acknowledgement), and visible only to the operator (`GET /healthz`
+ structured logs — never the PR itself). M8 also moved the reviewer-launching substrate to
**rootless Podman**; the honest TCB claim as of M8 is *"no root daemon and no root Magpie
process; the only setuid-root surface is two shadow-utils binaries (newuidmap/newgidmap) at
namespace setup."*

**Stack:** TypeScript/Node, npm workspaces, plus small native Rust helpers under `rust/`
(M8). `packages/orchestrator` — webhook server, queue, git ops, diff, container/micro-VM
reviewer runner, gateway client, publisher. `packages/review-extension` — the Pi
`report_findings` tool. `packages/gateway` (`@magpie/gateway`) — the host-side
credential-injecting LLM proxy. `docker/reviewer` — the published `magpie-reviewer` image.
`rust/magpie-tier-probe` — the `/dev/kvm` `KVM_CREATE_VM` preflight the isolation-tier ladder
shells out to; `rust/magpie-microvm-launcher` — the rootless-libkrun launcher for the opt-in
micro-VM tier. All present and implemented (see below).

**Status:** Milestones 1–8 are implemented and merged; Magpie works end-to-end and is
self-hostable. The pipeline is: webhook → HMAC verify → event/allowlist filter → queue →
GitHub App auth → credential-free clone → GitHub-API diff → resolve the isolation tier this
host can actually deliver (probe `/dev/kvm`/the micro-VM launcher/the crun runtime, pick the
strongest available, fail loud on an unacknowledged downgrade) → mint per-job gateway virtual
key → launch the reviewer at that tier — the hardened, rootless-Podman `--network none`
container at the shipped **crun-floor default**, or an opt-in rootless libkrun **micro-VM**
with a vsock-only gateway channel where configured (Pi over the diff either way) → parse
structured `report_findings` → post one `COMMENT` review with diff-anchored inline comments
(incremental + deduped on re-push) → cleanup (workspace, virtual key, reviewer sandbox). The
resolved tier is never part of that published review — it surfaces only on `GET /healthz` and
in operator logs. Remaining open work is the M6 nice-to-haves and M5-D cost logging — see
`PLAN.md` and `chalk ready`.

## Implemented so far (Milestones 1–8)

`packages/orchestrator/src/`:

- `config.ts` — loads/validates `config.toml` plus `MAGPIE_*` env secrets (webhook secret, GitHub App private key, gateway master key). No real LLM key here as of M4 — the orchestrator only ever holds the gateway master key.
- `server.ts` — `node:http` + `@octokit/webhooks`; verifies `X-Hub-Signature-256` before any payload parsing; also serves `/healthz`, whose JSON body includes the resolved isolation tier + probe evidence (M8-D2, `task_92d7`) — operator-only, by design never surfaced anywhere the PR review can carry it (see `publisher.ts`'s tier-silence guard test).
- `filter.ts` — accepts only `opened`/`ready_for_review`/`reopened`/`synchronize`, drops drafts, gates on `config.repoAllowlist`.
- `queue.ts` — in-process bounded-concurrency queue (`p-queue`), per-PR dedup, hard per-job wall-clock timeout backstop via `AbortController`.
- `github.ts` — mints a fresh 1h GitHub App installation token per job (`@octokit/auth-app`); never cached across jobs.
- `workspace.ts` — blobless clone of `refs/pull/{N}/head` from the base repo; the token reaches `git` only via an ephemeral env-backed credential helper (never argv/disk), and `origin` is rewritten tokenless before the checkout is used.
- `diff.ts` — PR diff sourced from the GitHub API (`pulls.get` diff media type), size-capped by `config.limits.maxDiffLines` before the diff body is ever fetched.
- `reviewer.ts` — launches the reviewer at the isolation tier `tier-ladder.ts` resolved for this host. At the **hardened crun floor (the shipped default)**: rootless Podman `run` of the `magpie-reviewer` container — `--network none`, `--cap-drop=ALL`, `--read-only`, non-root, mem/cpu/pids limits, `.git`-stripped read-only `/work` — with the exact flag set pinned byte-for-byte by the M8-B1 golden-argv test (`reviewer-crun-floor-argv.test.ts`, `task_89c4`) so it can't silently erode. At the **opt-in micro-VM tier**: a rootless libkrun micro-VM via `rust/magpie-microvm-launcher`, reaching the gateway over a per-job hybrid-vsock channel (`microvm-vsock.ts`) instead of a bind-mounted socket, with a fail-closed network-transport preflight (`findMicrovmNetworkTransportViolations`). Both tiers: read-only tool allowlist (`read,grep,find,ls`; no `bash`/`write`); injects only the per-job gateway virtual key; parses NDJSON output into a summary + usage. (M1/M2 ran Pi as a host subprocess; M3 containerized it, M7 removed its network; M8 added the tier ladder above the crun floor.)
- `tier-ladder.ts` — the M8 isolation-tier ladder: probes `/dev/kvm` (via `rust/magpie-tier-probe`'s `KVM_CREATE_VM` ioctl), the micro-VM launcher binary, and the crun-floor runtime CLI; resolves the strongest tier this host can actually deliver — **micro-VM > gVisor (deferred, `task_624d`) > hardened crun (the floor)** — and fails loud (`TierSelectionError`) rather than silently degrading unless the operator sets `MAGPIE_ACK_TIER` to the exact resolved (weaker) tier.
- `docker.ts` / `container-mounts.ts` / `orphan-cleanup.ts` — container-runtime CLI wrapper (rootless Podman by default as of M8-B2; any docker-compatible CLI), bind-mount assembly (read-only `/work`, per-job gateway socket dir), and reaping of orphaned review containers/launcher processes.
- `gateway.ts` — mints a budget-capped, short-lived per-job virtual key on the gateway's management plane before each run and revokes it on cleanup (`packages/gateway`).
- `findings.ts` / `anchor.ts` — parse/validate the reviewer's structured `report_findings` output and anchor each finding to a diff hunk; out-of-diff findings fold into the summary body rather than being dropped.
- `rereview.ts` — incremental re-review on `synchronize` (review only `before...after`), hidden `<!-- magpie:reviewed:<sha> -->` marker to track last-reviewed commit statelessly, and `minimizeComment` of prior magpie summaries.
- `publisher.ts` — posts exactly one `pulls.createReview` (`event: COMMENT`) per job with inline comments + summary (a clear failure note otherwise).
- `pipeline.ts` — wires auth → workspace → diff → head-SHA-mismatch guard → mint key → containerized review → publish → cleanup into the single `JobRunner` the queue drives.
- `shutdown.ts` / `index.ts` — composition root; drains in-flight jobs on `SIGINT`/`SIGTERM` before exit.

`packages/gateway/src/` — the host-side credential-injecting LLM gateway (own unprivileged user): OpenAI-compatible proxy plane served over a per-job unix socket, loopback-only management plane for mint/revoke, in-memory virtual keys with per-job USD budgets (the hard cost cap Pi lacks). See `packages/gateway/README.md`.

`packages/review-extension/src/` — the Pi `report_findings` tool (strict findings schema, `terminate: true`), baked into the reviewer image.

`docker/reviewer/` — the `magpie-reviewer` image (published multi-arch + cosign-signed to GHCR, digest-pinned in `config.example.toml`), its entrypoint (fail-closed confinement assertions), and the in-container TCP→unix `forwarder.mjs`.

Also implemented: `reviewer-prompt.md` (reviewer system prompt with untrusted-input handling); production systemd units (`systemd/magpie.service` — converted to the rootless-Podman + isolation-tier substrate in M8-D3, `task_67aa`, with its own header comment documenting exactly which seccomp-based hardening directives were removed to keep `newuidmap`/`newgidmap` working and what compensates; `systemd/magpie-gateway.service`, `systemd/cloudflared.service`) + `scripts/install.sh` (also provisions the rootless-Podman substrate and runs the KVM tier preflight as of M8-D3); a versioned host-service release tarball (`scripts/pack-host.sh` + release CI, now per-arch to bundle the native `magpie-tier-probe` binary); pluggable webhook ingress (`docs/ingress.md`: reverse proxy, Cloudflare Tunnel, other tunnels); and onboarding docs (`QUICKSTART.md`, `INSTALL.md` — both cover the isolation-tier ladder and the micro-VM opt-in).

**Remaining open work:** M5-D cost logging (`task_8a10`); the M6 nice-to-haves — `@magpie review` on-demand command (`task_ad15`), per-repo `.magpie.toml` (`task_220f`), multi-provider support (`task_9c9d`); and gVisor (`task_624d`, now formally the M8 isolation ladder's deferred middle tier — see `PLAN.md`, still pending). M8's own rootless-micro-VM-sandbox epic (`epic_59b1`) retired the earlier M6-E rootless-docker-path direction as superseded. Run `chalk ready` for the current queue.

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