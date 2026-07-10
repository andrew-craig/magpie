---
id: task_d8aa
title: M3-D: pipeline integration + config wiring + live e2e verification
type: task
status: closed
priority: 1
labels: []
blocked_by: []
parent: epic_a580
remote_task_url: null
created_at: 2026-07-10T06:47:25Z
updated_at: 2026-07-10T21:18:52Z
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

## Live E2E Verification (M3)

Date: 2026-07-11

**Setup:** Image confirmed current via `scripts/build-reviewer-image.sh` (`docker images` shows
`magpie-reviewer:0.1.0`, id `8c376ffb861e`). `config.toml` has no `[container]` override, so the
config.ts default `image = "magpie-reviewer:0.1.0"` is what ran. Orchestrator started via
`npm run dev` on branch `m3-containerize` (host process, real Pi + OpenRouter `z-ai/glm-5.2`),
listening on `127.0.0.1:8787`, exposed via the existing `cloudflared` systemd tunnel
(`magpie.seatrain.net`). Startup log confirmed the docker preflight passed (process didn't abort)
and orphan cleanup ran and found nothing (`{"event":"orphan-cleanup","removedCount":0}`) — logged
right after `assertDockerAvailable`, before `magpie-started`. `GET /healthz` returned `ok` both
locally and through the tunnel.

A throwaway branch `e2e-m3-probe-1783717580` was created off `origin/main` (NOT off
`m3-containerize`) adding `e2e-probe-m3.js` with two intentional, genuine defects: an inverted
upper-bound comparison in `clamp` (`value < max` instead of `value > max`) and an `isEven`
that actually tests for odd (`n % 2 === 1`). This fired PR **#26**:
https://github.com/andrew-craig/magpie/pull/26

**Job lifecycle** (from `/tmp/magpie-e2e-m3.log`, three pushes to drive `synchronize` deliveries —
`opened` + two follow-up pushes, the last used to capture `docker ps` mid-run):

```
start id=3e046511-d3d2-44cf-9fe4-1898f6a25978 headSha=a8c35655...
minting-token → computing-diff → running-review
[reviewer] pi run complete: turns=1 tokens(in/out/total)=4277/506/5487 cost=$0.0056
publishing-review (resultOk=true)
published-review commentId=4675016602
  commentUrl=https://github.com/andrew-craig/magpie/pull/26#pullrequestreview-4675016602
workspace-cleaned
finish durationMs=40222 outcome=success
```

**Container evidence — job ran inside `magpie-reviewer`:**
`docker ps` polled every 0.4s during the third push's job caught the container live for its whole
run, e.g.:
```
[07:10:29] magpie-3e046511-d3d2-44cf-9fe4-1898f6a25978  Up 3 seconds
...
[07:11:01] magpie-3e046511-d3d2-44cf-9fe4-1898f6a25978  Up 35 seconds
```
(container name == `magpie-<jobId>`, confirming pipeline.ts's `jobId: job.id` threading into
`runReview` — see reviewer.ts's `buildContainerName`). Immediately after `finish` was logged,
`docker ps -a --format '{{.Names}}' | grep magpie-` returned nothing — container fully removed
(the `docker run --rm` path, no kill needed since this run completed normally).

**Read-only, `.git`-free mount (verified from source, since M3-C already bakes this into every
`docker run`):** reviewer.ts's `dockerArgs` always includes `"--read-only"` and
`` `${mountDir}:/work:ro` ``, and `mountDir` comes from `prepareReviewMount(workspace.dir)`, which
`rm -rf`s `.git` from the checkout in place before it's ever bind-mounted — see reviewer.ts:255,266
and container-mounts.ts:44-47. `findings.json` is read back from `output.findingsPath`
(`<hostOutDir>/findings.json`, the host side of the `-v <out>:/out` mount) only after a clean
container exit, and the posted review's findings (below) came from exactly that channel — there is
no other code path that produces `ReviewResult.findings`.

**Posted review** (final push, `headSha` `a8c35655...`) — verified via `gh api`:
- Exactly **one** review for this delivery: id `4675016602`, author `magpie-reviewer[bot]`,
  `state: COMMENTED`.
- Review body (marker + summary + usage footer):
  > `<!-- magpie-review -->` "## 🐦 Magpie review — This throwaway M3 e2e probe (as stated in the PR
  > description) contains two genuine correctness defects in `e2e-probe-m3.js`: an inverted
  > upper-bound comparison in `clamp` (line 10) and an `isEven` implementation that actually tests
  > for odd (line 20)..." — footer: `_turns=1 tokens=5487 cost=$0.0056_`
- **2 inline comments**, both diff-anchored, both `original_line == line` (no drift):
  - `e2e-probe-m3.js:11` — "Blocking (correctness) — The upper-bound check uses `value < max`
    instead of `value > max`..."
  - `e2e-probe-m3.js:20` — "Blocking (correctness) — `isEven` returns `n % 2 === 1`, which is true
    for odd numbers, not even ones..."
- Issue comments on #26 at this point = **0** — no stray/duplicate `issues.createComment`; the
  review body is the sole summary. (Across all three pushes in the success run, every push produced
  exactly one review and zero issue comments each time — three total magpie-reviewer reviews, one
  per head sha, which is expected M1/M2 per-push behaviour, not a duplicate-posting bug. An unrelated
  pre-existing `gemini-code-assist[bot]` review also appeared on the PR — not part of magpie.)
- Workspace: `/var/lib/magpie/work` empty (only `.`/`..`) after `workspace-cleaned`; no leftover
  `magpie-out-*` temp dirs under `/tmp`.

**Timeout/abort case:** `config.toml`'s `job_timeout_seconds` temporarily set to `5`, orchestrator
restarted (fresh startup log again showed the preflight pass + `orphan-cleanup removedCount=0`).
A fourth push (`headSha` `1d189ead...`) drove a `synchronize` job that could not finish inside 5s:

```
start id=6cadc986-bf00-4cd7-8eb3-d300aaf5fd36
minting-token → computing-diff → running-review
publishing-review (resultOk=false)
published-review commentId=4939585196
  commentUrl=https://github.com/andrew-craig/magpie/pull/26#issuecomment-4939585196
workspace-cleaned
finish durationMs=9476 outcome=success
```

- `resultOk=false` and the published comment is an `issues.createComment` (URL contains
  `#issuecomment-...`, not `#pullrequestreview-...`) — the M1/M2 failure-note path, not a review.
- Comment body: `"Magpie could not complete a review of this PR.\n\nReason:\n\`\`\`\ntimeout after 5s\n\`\`\`"`
  — the PR gets a clear failure note, not silence.
- `durationMs=9476` (~9.5s: the 5s `runReview` timeout plus the `KILL_GRACE_MS` SIGTERM→SIGKILL
  window) confirms the container was actually killed rather than left to finish.
- `docker ps -a --format '{{.Names}}' | grep magpie-` immediately after: **empty** — no container
  left running or dangling.
- No new PR review was posted for this head sha (review count stayed at 3; issue-comment count on
  the PR became 1, exactly the failure note above) and no leftover `/var/lib/magpie/work` or
  `/tmp/magpie-out-*` directories.

**Cleanup performed:**
- PR #26 closed and remote branch `e2e-m3-probe-1783717580` deleted via
  `gh pr close 26 --repo andrew-craig/magpie --delete-branch`.
- Orchestrator background process stopped (`SIGTERM`, graceful `shutting-down` logged); port 8787
  confirmed free.
- `config.toml`'s `job_timeout_seconds` restored from `5` back to `600`.
- Local throwaway checkout (`/tmp/magpie-e2e-checkout`) removed.
- Run logs left in place: `/tmp/magpie-e2e-m3.log` (success run, three pushes) and
  `/tmp/magpie-e2e-m3-timeout.log` (timeout run).

**Verdict: PASS.** Single `COMMENTED` review per push with two genuinely diff-anchored inline
findings, correct usage footer, zero stray issue comments, container evidence captured live via
`docker ps` and confirmed removed after, workspace/out dirs cleaned. Timeout case: container killed
within the SIGTERM/SIGKILL grace window, no orphaned container or temp dirs, and the PR received the
M1/M2 failure comment instead of going silent. Nothing to re-run.
