---
id: task_0d97
title: M2-E: pipeline integration + live e2e verification
type: task
status: in_progress
priority: 1
labels: []
blocked_by: []
parent: epic_e6e6
remote_task_url: null
created_at: 2026-07-09T06:34:40Z
updated_at: 2026-07-10T02:02:19Z
---
Integrate the structured-findings flow end-to-end through pipeline.ts and live-verify against a real PR, mirroring the M1 e2e acceptance.

SCOPE (pipeline.ts):
- Thread the new ReviewResult through: on {ok:true} with findings, call task_876d anchorFindings(prDiff.diff, result.findings) then task_6fa4's publishReviewWithFindings (inline review). tooLarge synth-summary path and {ok:false} failure path keep posting the M1 single summary comment (publishReview) unchanged. Keep the one-token-per-job, try/finally workspace cleanup, HEAD-VERIFY, and abort-guard structure intact.
- Ensure pipeline.test.ts's offline fakes cover the new anchor+inline-review path (findings → inline comments) as well as the tooLarge and failure paths.

LIVE E2E (host, real Pi + OpenRouter, like M1): run the orchestrator (npm run dev) against a real synchronize/opened event on andrew-craig/magpie test PR; confirm ONE magpie-reviewer[bot] COMMENT review with inline comments on diff lines + a summary body (with Other observations if any), correct usage footer, workspace cleaned, no duplicate comments/reviews. Capture the run's turns/tokens/cost and the comment/review URLs as evidence in this task file.

Gate: full 'npm test' green + tsc clean across BOTH workspaces before opening the PR.

Depends on task_6fa4 + task_7d6c (final integration).

## Live E2E Verification (M2-E)

Date: 2026-07-10

**Setup:** Orchestrator started via `npm run dev` on branch `m2-wave3` (host subprocess,
real Pi 0.80.3 + OpenRouter `z-ai/glm-5.2`), listening on `127.0.0.1:8787`, exposed via the
existing cloudflared tunnel. `/healthz` returned `ok`. A throwaway branch
`e2e-m2-probe-1783650469` was created off `origin/main` (NOT off `m2-wave3`) adding
`e2e-probe.js` with two intentional defects (an off-by-one loop bound `i <= arr.length`, and
a misleading comment about `value == null`). This fired PR **#24**:
https://github.com/andrew-craig/magpie/pull/24

**Job lifecycle** (from `/tmp/magpie-e2e.log`, job id `47ada7d5-d8f2-4415-8536-0afb0e3eb1a4`):

```
start → minting-token → computing-diff → running-review
[reviewer] pi run complete: turns=1 tokens(in/out/total)=4808/638/5510 cost=$0.0064
publishing-review (resultOk=true)
published-review commentId=4668132652
  commentUrl=https://github.com/andrew-craig/magpie/pull/24#pullrequestreview-4668132652
workspace-cleaned
finish durationMs=191446 outcome=success
```

**Posted review** — verified via `gh api`:
- Exactly **one** review on PR #24: id `4668132652`, author `magpie-reviewer[bot]`,
  `state: COMMENTED`. Review count via API = 1.
- Review body (marker + summary + usage footer):
  > `<!-- magpie-review -->` "## 🐦 Magpie review — This is a self-described throwaway E2E
  > probe, but the diff contains real reviewable defects. The substantive one is an off-by-one
  > in `sumArray`: `i <= arr.length` reads one element past the array, adding
  > `undefined`/`NaN` to the total. The second item is a misleading comment claiming
  > `value == null` is a buggy loose-equality check when it is in fact the idiomatic and
  > correct null/undefined test. The `unusedFlag` unused-variable is a linter-level nit and
  > not reported." — footer: `_turns=1 tokens=5510 cost=$0.0064_`
- **2 inline comments**, both diff-anchored, both `original_line == line` (no drift):
  - `e2e-probe.js:9` — "Important (correctness) — Off-by-one loop bound: `i <= arr.length`
    reads `arr[arr.length]`, which is `undefined`... The loop condition should be
    `i < arr.length`." (with a suggestion block).
  - `e2e-probe.js:15` — "Nit (clarity) — The comment claims `value == null` is a sloppy
    loose-equality check... That is misleading: `value == null` is the standard idiom..."
    (The reviewer correctly identified my probe's own comment as the misleading part rather
    than flagging idiomatic null-check code — a legitimate finding.)
- Inline comment count via API = 2.
- Issue comments on #24 (`gh api .../issues/24/comments`) = **0** — no stray/duplicate
  `issues.createComment` summary; the review body is the sole summary.
- Workspace: `/var/lib/magpie/work` contains no leftover job directory (only `.` and `..`)
  after `workspace-cleaned`.

**Cleanup performed:**
- PR #24 closed and remote branch `e2e-m2-probe-1783650469` deleted via
  `gh pr close 24 --repo andrew-craig/magpie --delete-branch`.
- Orchestrator background process stopped; port 8787 confirmed free.
- `/tmp/magpie-e2e.log` left in place with the full run log.

**Verdict: PASS.** Single `COMMENTED` review, two genuinely diff-anchored inline findings
on the intentionally-buggy lines, correct usage footer, no duplicate comments, workspace
cleaned. Nothing to re-run.
