---
id: task_4a75
title: M5-C: re-review dedup + comment minimization — reviewed-SHA marker, minimizeComment(OUTDATED)
type: task
status: in_progress
priority: 2
labels: []
blocked_by: []
parent: epic_d6c1
remote_task_url: null
created_at: 2026-07-10T21:52:22Z
updated_at: 2026-07-12T23:07:28Z
---
Wave 2 (builds on M5-B's synchronize handling). PLAN.md §7 re-review dedup, so the PR doesn't fill with stale bot reviews.

- Embed a hidden HTML marker in every magpie summary: <!-- magpie:reviewed:<head-sha> -->. Before reviewing, read magpie's own prior comments/reviews on the PR to find the last-reviewed SHA — stateless tracking from GitHub itself (no local DB). Skip the job if the current head SHA is already reviewed (dedup for replayed/duplicate webhooks).
- The last-reviewed SHA is also the natural 'before' for M5-B's incremental range when it's more reliable than the webhook payload.
- After posting a new review, minimize magpie's previous summary comments via the GraphQL minimizeComment mutation with classifier OUTDATED (needs the GraphQL endpoint with the installation token; verify the App permissions cover it). Minimize only magpie's own comments, matched by the existing marker — never touch human comments.
- Failures to minimize must not fail the job (log and continue).

Done when: pushing three times to a PR leaves one visible current review, older magpie summaries minimized as outdated, and a redelivered webhook for an already-reviewed SHA is a no-op.

---

## Plan (tech-lead, CTO-approved 2026-07-13)

Branch `m5-rereview-dedup` off main. Delegated to a sonnet subagent.

### CTO decisions
- **Minimize scope = "only what GitHub allows".** GitHub's GraphQL `minimizeComment` accepts only Minimizable nodes: `IssueComment` and `PullRequestReviewComment` (inline). A `PullRequestReview` object (magpie's normal success summary) is NOT minimizable — so we do NOT change the publish shape and we do NOT split the summary into a separate issue comment. We minimize prior magpie **issue comments** (failure/too-large notes) + prior magpie **inline review comments**. Superseded review summary bodies stay visible (accepted trade-off).
- **Incremental `before` prefers the last-reviewed SHA**, falling back to the webhook `before`.

### Design
1. **Markers.** Keep existing `<!-- magpie-review -->` (identity). ADD `<!-- magpie:reviewed:<headSha> -->` to every *definitive-outcome* publish: successful reviews + too-large skips. Do NOT add it to `{ok:false}` failure notes — so a redelivered webhook can retry a transient failure. Publisher functions gain an optional `reviewedSha?` param; pipeline passes `result.ok ? job.headSha : undefined` for `publishReview`, and `job.headSha` for `publishReviewWithFindings`.
2. **Read review state (new fn, e.g. `rereview.ts`).** `readReviewState({octokit, owner, repo, prNumber})` paginates `issues.listComments` + `pulls.listReviews` + `pulls.listReviewComments`. Magpie's own = body contains `<!-- magpie-review -->` (issue comments + review bodies); inline comments are magpie's when their `pull_request_review_id` ∈ magpie review ids. Returns: `lastReviewedSha` (from the `magpie:reviewed:<sha>` marker on the most-recent-by-`created_at` magpie comment/review body), plus captured `node_id`s of prior minimizable nodes = magpie issue comments ∪ magpie inline review comments (NOT review node_ids — not minimizable).
3. **Dedup skip.** In pipeline, right after the octokit is built and BEFORE minting the gateway key / cloning (to save cost), call `readReviewState`. If `lastReviewedSha === job.headSha` → log `event:"already-reviewed"` and return (no-op). Best-effort: any error reading state is logged and treated as "not reviewed" (proceed) — never fail the job on a read error.
4. **Incremental before.** When `job.before` is present (synchronize), pass `base: lastReviewedSha ?? job.before` to `computeIncrementalDiff`. `computeIncrementalDiff` already falls back to the full PR diff on any bad/GC'd/diverged base, so a stale marker SHA is safe.
5. **Minimize after publish.** After a successful publish, call `minimizeOutdated(octokit, priorNodeIds, logger)` on the node_ids CAPTURED IN STEP 2 (pre-publish snapshot — avoids self-minimizing the artifact just posted). GraphQL `minimizeComment(input:{subjectId, classifier: OUTDATED})` per node. Per-node try/catch: log + continue; a minimize failure NEVER fails the job. Optionally skip nodes already `isMinimized`.
6. **GraphQL/permissions.** Use `octokit.graphql` (installation token). Verify App has `issues:write` + `pull_requests:write` (already required to post) covers minimize. Note finding in task review.

### Concurrency / edge notes
- TOCTOU between the dedup read and publish is acceptable — the queue's per-PR dedup + this best-effort GitHub-state check covers the realistic replayed-webhook / restart case. Document, don't over-engineer.
- On `opened`/`reopened` (no prior magpie review) `lastReviewedSha` is undefined → proceed, full review, no minimize targets.

### Tests (vitest, offline fake octokit — extend the pipeline.test.ts seam)
- dedup skip when `lastReviewedSha === headSha`; proceed when different/absent.
- reviewed marker embedded on success + too-large, ABSENT on failure.
- `readReviewState` parses latest SHA across mixed issue-comments/reviews; ignores non-magpie comments.
- minimize called with `OUTDATED` on prior issue-comment + inline-comment node_ids only; NOT on review node_ids; NOT on the just-posted artifact.
- a minimize GraphQL error is swallowed → job still reports success.
- incremental base prefers `lastReviewedSha` over `job.before`.
- state-read error → job proceeds (no skip), not a crash.
- Full `npm test` + typecheck/lint green; no secret ever logged.

### Verification
- Unit/integration (fake octokit) is the bar for this task. Live 3-push e2e against a real PR is CTO-gated (real cost + real comments) — I'll schedule separately if wanted.
