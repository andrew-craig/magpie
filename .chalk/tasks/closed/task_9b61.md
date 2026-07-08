---
id: task_9b61
title: End-to-end integration on a test repo
type: task
status: closed
priority: 1
labels: []
blocked_by: []
parent: epic_04f9
remote_task_url: null
created_at: 2026-07-05T22:58:17Z
updated_at: 2026-07-08T11:53:10Z
---
Wire the pieces into one pipeline and prove the full loop against a real test repo — the milestone exit criterion.

Context: All the individual pieces exist by now; this task connects them and validates the whole walking skeleton: webhook -> filter -> queue -> (clone -> diff -> Pi -> post). Runs on the host with smee.io relaying webhooks; no container/tunnel/gateway yet.

Scope:
- Assemble the per-job pipeline: for an accepted event, the queue runs clone -> diff -> Pi -> post comment, with cleanup on success/failure/timeout.
- A single top-level entrypoint that starts config load, the webhook server, the filter, and the queue together.
- Create/prepare a TEST REPO and install the dev GitHub App on it; add it to the repo_allowlist.
- Run the full flow: open a PR on the test repo and confirm magpie posts a summary comment automatically.
- Write a short README/runbook section: how to configure, run the relay + orchestrator, and reproduce the demo.

Acceptance criteria:
- Opening a non-draft PR on the allowlisted test repo results in one magpie summary comment, end-to-end, with no manual steps beyond opening the PR.
- The workspace is cleaned up after the job.
- The run is documented well enough to repeat.

Dependencies: task_d4a8 (dev relay), task_3c49 (event filtering), task_6431 (queue), task_292c (post comment) — which transitively pull in auth, clone, diff, Pi.

---

## Plan (tech-lead, 2026-07-08)

Split: subagent writes the CODE (pipeline + entrypoint + tests + runbook) in an
isolated worktree with offline gates; the LIVE acceptance run is host-side
(operator sets `MAGPIE_SMEE_URL` + points the App webhook at the channel) and is
driven after merge. This repo (`andrew-craig/magpie`, already on the allowlist)
is the test repo.

### Code
- [x] `runJob(job, signal)` — per-job pipeline (packages/orchestrator/src/pipeline.ts):
  1. Guard: no `installationId` -> log + throw (can't mint token).
  2. Mint ONE installation token (github.ts `mintInstallationTokenFromConfig`).
  3. Build API client `new Octokit({ auth: token })` — reuse the single token for
     diff + publish (coherent with "mint fresh per job"; avoids double-mint).
  4. Fetch PR title/body via `octokit.rest.pulls.get` (JSON) — not on JobDescriptor.
  5. `createWorkspace({owner,repo,prNumber,headSha,token,workDir})` (credential-free).
  6. `computePrDiff({octokit,...,maxDiffLines})`.
  7. tooLarge -> publish summary-only "PR too large (N > cap), skipped" (synth
     ok:true ReviewResult); else `runReview({workspaceDir,diff,changedFiles,prTitle,prBody,config})`.
  8. `publishReview({octokit,owner,repo,prNumber,result})`.
  9. `finally`: `workspace.cleanup()` — always (success/failure). Structured logs
     per stage; NEVER log the token/key/Octokit.
- [x] `cleanupJob(job)` — queue timeout hook: `rm -rf` the deterministic workspace
  dir (`<workDir>/<owner>-<repo>-<prNumber>-<headSha>`) so a timed-out job leaves
  nothing behind (queue only calls cleanup on timeout; runJob's finally covers the rest).
- [x] `index.ts` entrypoint: `loadConfig()` -> `new JobQueue(jobQueueOptionsFromConfig(config))`
  -> `createPullRequestFilter(config, job => queue.enqueue(job, runJob, cleanupJob))`
  -> `createWebhookServer(config, filter)` -> `listen()` -> SIGINT/SIGTERM graceful `close()`.
- [x] Offline integration test (pipeline.test.ts, 5 cases): happy path posts one comment
  + cleans up; tooLarge posts summary-only (no diff-body fetch, no pi run); missing
  installationId rejects + posts nothing; review-failure still posts a failure comment;
  token never logged/published. Workspace injected as a temp-dir factory (not a git
  fixture — pipeline runs no git; workspace.test.ts already covers real git plumbing).

### Docs
- [x] README "Running" refreshed (placeholder language gone; full M1 pipeline
  documented). Added an ingress-agnostic e2e runbook cross-linking BOTH
  docs/cloudflared.md (prod) and docs/smee.md (dev).

### Gates (tech-lead ran in worktree AND on the PR branch)
- [x] `npm run build` (tsc) clean; `npm test` all green: **81 passed** (76 prior + 5 new).

### Live acceptance (host) — PASSED 2026-07-08
Ingress: **cloudflared** (production path). CTO did `cloudflared tunnel login` + owns
`seatrain.net` on a CF zone; I ran `./scripts/setup-cloudflared.sh magpie.seatrain.net`
(created tunnel `magpie` 8494ac6c…, DNS CNAME, rendered /etc/cloudflared/config.yml →
127.0.0.1:8787), installed+started `cloudflared.service` (User/Group=operator). Verified
public path: `POST https://magpie.seatrain.net/webhook` → 400 (HMAC gate), `/healthz` → 200.
CTO set the GitHub App webhook URL → that hostname + enabled pull_request events.
- [x] Tunnel provisioned; GitHub App webhook points at magpie.seatrain.net/webhook.
- [x] Pushed to test PR #19 (branch magpie-e2e-test off main) → synchronize delivery →
  full pipeline ran: mint-token → diff → **live Pi review (turns=5, $0.0217, ~81s)** →
  published ONE `magpie-reviewer[bot]` COMMENT (id 4914454133) with the `<!-- magpie-review -->`
  marker + 🐦 header + usage footer; workspace cleaned up; outcome=success. Comment count=1
  (no dupes). Reviewer even caught a real dangling-README-reference in the test doc.

### Two host-config fixes found during the live run (not code bugs)
1. **EACCES on `/var/lib/magpie`** — default `work_dir` wasn't provisioned for the
   `operator` user. Fixed: `sudo mkdir -p /var/lib/magpie/work && chown operator`. (When
   magpie later runs under its own systemd unit, `StateDirectory=magpie` handles this.)
2. **Failed jobs logged no reason** — the queue logs only terminal status; index.ts did
   `void queue.enqueue(...)`, dropping `JobOutcome.error`. Fixed in index.ts: observe the
   settled outcome and `console.error` a `job-failed` line (redaction already handled
   upstream in workspace.ts). This surfaced fix #1 immediately. Folded into PR #18.

## Review (tech-lead, 2026-07-08)

Delegated code to a sonnet subagent (worktree-isolated); I reviewed the full diff and
re-ran gates on the PR branch. Outcome:

- **pipeline.ts** — `createReviewPipeline(config, deps?)` returns `{ runJob, cleanupJob }`.
  Single fresh installation token per job, reused for PR-metadata fetch + diff + publish
  (deliberately NOT `createInstallationOctokit`, which would double-mint). `try/finally`
  guarantees `workspace.cleanup()` on every exit; tooLarge synthesizes an ok summary and
  skips Pi; runReview failures are published (not thrown) as a failure comment.
- **index.ts** — real entrypoint: config → queue → pipeline → filter → server → listen,
  with SIGINT/SIGTERM graceful close.
- **Security** — verified the token flows ONLY into `new Octokit({auth})` and
  `createWorkspace({token})`; every log payload is ids/counts/urls; a dedicated test
  asserts the token never appears in logs or the comment body.
- **Test seam** — added a `PipelineDeps` injection (`mintToken`/`makeOctokit`/`piBinary`/
  `createWorkspace`/`logger`), matching the codebase's existing seam pattern; production
  (index.ts) passes no deps, so it always gets the real implementations.
- Subagent flagged a real repo-wide gotcha worth remembering: zero-arg `vi.fn(async () =>
  ...)` infers an empty-tuple `mock.calls[0]`, so `.calls[0][0]` fails a strict
  `tsc --noEmit` even though vitest's transpile-only run passes. See [[magpie-m1-process]].

Gates: tsc clean, 81/81. **Live cloudflared acceptance run PASSED** (see above) — M1
walking skeleton proven end-to-end on a real PR. Added `job-failed` error logging to
index.ts during the live run (gates still 81/81). Closing task; M1 exit criterion met.
