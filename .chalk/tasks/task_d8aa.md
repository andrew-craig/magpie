---
id: task_d8aa
title: M3-D: pipeline integration + config wiring + live e2e verification
type: task
status: open
priority: 1
labels: []
blocked_by: [task_4ed4]
parent: epic_a580
remote_task_url: null
created_at: 2026-07-10T06:47:25Z
updated_at: 2026-07-10T09:22:13Z
---
Wave 3 (depends on task_4ed4 runner + task_5b3a image). Finish M3: make sure the containerized
runner is threaded correctly through `pipeline.ts`, that all container/mount resources are cleaned
up on every exit path, and prove the whole loop works against a real PR — mirroring the M1/M2 e2e
acceptance (see task_0d97's "Live E2E Verification" section for the bar to hit).

## Scope — pipeline.ts integration

- Thread whatever M3-C added to `RunReviewParams` (the `jobId`/`containerName`) from the pipeline's
  job context into `runReview`. Use the queue/job's existing id if there is one.
- Confirm the existing `try/finally` workspace cleanup still holds AND that the new container mount
  dir + `/out` dir are cleaned up on success, failure, timeout, and abort (whether that cleanup lives
  in `runReview` or the pipeline — decide with M3-C, but there must be exactly one owner and no leak).
- The abort/timeout path must actually stop the container (the queue's `AbortController` → M3-C's
  `docker kill`). Verify a timed-out job leaves **no** running `magpie-<id>` container and no leftover
  temp dirs.
- Everything downstream of the reviewer is UNCHANGED: findings → `anchorFindings` → one
  `pulls.createReview(event=COMMENT)` with inline comments + summary, `Other observations` fold,
  tooLarge synth-summary path, and `{ok:false}` failure → single `issues.createComment`. Do not
  regress M2 behaviour.
- **Orphan cleanup (defence-in-depth):** on orchestrator startup and/or graceful shutdown
  (`shutdown.ts`), best-effort remove any dangling `magpie-*` containers from a previous crash
  (`docker ps -aq --filter name=magpie- | xargs -r docker rm -f`, via the config `docker_bin`). Small,
  logged, non-fatal.

## Tests

- Update `pipeline.test.ts` offline fakes so the reviewer step is the containerized path; keep the
  existing coverage of the inline-review, tooLarge, and failure paths green.
- Add/confirm a test that the abort path invokes container kill and cleanup.
- `npm test` green + `tsc` clean across BOTH workspaces before opening the PR (same gate as M2).

## Live E2E (host, real docker + real Pi + OpenRouter) — REQUIRED, document as evidence

Mirror task_0d97's M2 e2e exactly, but now the review runs in the container:

1. Build the image first: `scripts/build-reviewer-image.sh` (M3-A). Confirm `docker images` shows the
   configured tag.
2. Point `config.toml` at the container image tag and run the orchestrator (`npm run dev`) on the M3
   branch, exposed via the existing cloudflared tunnel; confirm `/healthz` = ok and the docker
   preflight passed at startup.
3. Open a throwaway PR on `andrew-craig/magpie` (branch off `origin/main`, NOT the M3 branch) adding a
   small file with 1–2 intentional, genuine defects (as in task_0d97). Let the webhook fire.
4. **Verify and record in this task file** (capture URLs + numbers as task_0d97 did):
   - Exactly ONE `magpie-reviewer[bot]` `COMMENTED` review, with the diff-anchored inline comment(s)
     on the buggy line(s) + summary body + correct `turns/tokens/cost` usage footer, and ZERO stray
     `issues.createComment`. (Proves parity with M2 through the container.)
   - The job actually ran in a container: capture evidence (e.g. `docker ps` during the run showing
     `magpie-<jobid>`, or a log line), and that it was removed afterwards (`docker ps -a` clean).
   - The mounted worktree had **no `.git`** and was **read-only**, and findings.json came from the
     mounted `/out` dir (spot-check from logs).
   - Workspace + mount + out temp dirs all cleaned; no leftover containers/images-dangling.
5. **Then force a timeout/abort case** (e.g. temporarily set a very low `job_timeout_seconds`, or a
   PR large enough to exceed it) and confirm: the container is `docker kill`ed, no container is left
   running, temp dirs cleaned, and the PR gets the M1/M2 "review failed"/timeout comment — not silence.
6. Cleanup: close the throwaway PR + delete its branch, stop the orchestrator, free the port, and note
   the run log location — exactly as task_0d97's cleanup section.

## Acceptance criteria

- Green tests + clean tsc across both workspaces.
- Documented live e2e PASS (success run + timeout run) with URLs, container evidence, and cleanup —
  in a "## Live E2E Verification (M3)" section in this file.
- No behavioural regression vs M2; the only change a PR author sees is that review now runs in a
  container (invisible to them).

## Out of scope

Gateway, per-job virtual keys, `magpie-net`, iptables egress lockdown, fail-closed egress assertion —
all M4.

Depends on: task_4ed4, task_5b3a. Closing this + all siblings closes epic_a580 (M3).
