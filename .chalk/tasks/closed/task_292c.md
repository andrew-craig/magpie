---
id: task_292c
title: Post single summary comment to the PR
type: task
status: closed
priority: 1
labels: []
blocked_by: []
parent: epic_04f9
remote_task_url: null
created_at: 2026-07-05T22:58:08Z
updated_at: 2026-07-08T07:54:48Z
---
Publish the review result back to the PR as one summary comment authored by the GitHub App identity.

Context: For the walking skeleton we post a SINGLE summary comment (not a formal review with inline comments — that's M2). Use the per-job installation token from the GitHub App auth task. If Pi failed to produce a review (Pi runner failure path), post a short review-failed note instead of staying silent.

Scope:
- Using the authenticated installation client, post the review text as a single issue comment on the PR (POST /repos/{owner}/{repo}/issues/{number}/comments), or an equivalent single-comment mechanism.
- Include a small magpie header/marker in the comment body so magpie comments are identifiable (useful for later dedup/minimization milestones).
- On the Pi-failure path, post a concise magpie review failed comment.
- Keep it to ONE comment per job in this milestone.

Acceptance criteria:
- A successful job results in exactly one summary comment on the PR, authored by the App identity.
- A failed Pi run results in one clear failure comment, not silence.
- Comment includes an identifiable magpie marker.

Dependencies: task_b5cf (installation token/client), task_c53d (review text to post).

## Review

Implemented in `packages/orchestrator/src/publisher.ts` (+ `publisher.test.ts`); PR #17.

- `publishReview({ octokit, owner, repo, prNumber, result })` posts exactly one issue comment via `octokit.issues.createComment` and returns `{ id, url }`. Both `ReviewResult` branches are always published — never silent.
- **ok path:** `MAGPIE_REVIEW_MARKER` (`<!-- magpie-review -->`, exported const for later dedup) + `## 🐦 Magpie review` header + `summary`, plus a compact `_turns/tokens/cost_` footer when usage telemetry is present.
- **failure path:** marker + header + "Magpie could not complete a review of this PR" + the `reason` rendered verbatim inside a fenced code block (`fenceReason()` computes a fence wider than any backtick run in the reason so error text can't break out — addresses PR #17 review). The ok-path summary is deliberately left as raw markdown (agent-authored review).
- **Test seam:** `MinimalIssuesClient` narrows to just `issues.createComment`, so a real `Octokit` satisfies it in prod and a `vi.fn()` fake drives fully-offline tests (mirrors reviewer.ts's `piBinary` seam).
- **Secret safety:** the comment body is assembled only from `summary`/`reason` — never from the client/config/env — so there is no path for the installation token to reach a PR comment (enforced by test).

Acceptance criteria all met. Gates: `tsc` build clean; `npm test` → 76 tests pass. One Gemini review finding (markdown-corruption of the reason) addressed with a code fence, not the suggested blockquote (blockquotes still parse inline markdown).
