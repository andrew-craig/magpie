---
id: task_6fa4
title: M2-C: publisher — single COMMENT review with inline comments
type: task
status: closed
priority: 1
labels: []
blocked_by: []
parent: epic_e6e6
remote_task_url: null
created_at: 2026-07-09T06:34:22Z
updated_at: 2026-07-09T22:45:41Z
---
Upgrade publisher.ts to post structured findings as ONE pull-request review with inline comments, replacing M1's single summary issue-comment on the success-with-findings path.

SCOPE (publisher.ts):
- New publishReviewWithFindings path using octokit.rest.pulls.createReview({ owner, repo, pull_number, event:'COMMENT', body, comments }). event is ALWAYS 'COMMENT' — Magpie never approve/request-changes regardless of the model's advisory verdict (see PLAN.md §7 and CLAUDE.md). comments[] built from task_876d anchorFindings().inline (path, line, side:'RIGHT', start_line?, body=formatted finding w/ severity+category+message+optional suggestion).
- body = MAGPIE_REVIEW_MARKER + header + summary + an 'Other observations' section listing the out-of-diff findings (anchorFindings().other) as a markdown list with file:line, so nothing is silently dropped (PLAN.md §7 constraint). Include usage footer as today.
- FALLBACK: if createReview returns 422 (a comment anchored to a line GitHub rejects), retry ONCE with comments:[] and the un-anchorable findings appended into the body under 'Other observations'; if THAT fails, fall back to the existing single issues.createComment. Never go silent, never throw (mirror M1 contract).
- Keep buildFailureBody + fenceReason + the failure issues.createComment path UNCHANGED for {ok:false}. Keep the no-findings success case (findings.length===0) posting a plain summary issue-comment (back-compat).
- Extend MinimalIssuesClient test seam to also cover pulls.createReview.

TESTS: inline comments built from anchored findings; other[] rendered in body; event always COMMENT; 422 retry folds inline into body then falls back; failure path unchanged; secret-leak invariant still holds; no-findings posts plain comment.

Depends on task_876d (imports Finding/InlineComment types + anchorFindings). Coordinate ReviewResult shape with task_ceb4/task_876d.

---
## TECH-LEAD COORDINATION NOTE (m2-wave2 dispatch, 2026-07-10)

Assigned to a sonnet subagent in a worktree off branch `m2-wave2`. Runs in parallel with task_7d6c (reviewer). Files are DISJOINT: this task owns `publisher.ts` + `publisher.test.ts` ONLY. Do NOT touch reviewer.ts or pipeline.ts.

DECISIONS:
- `publishReviewWithFindings` is DECOUPLED from reviewer's new ReviewResult. It takes already-anchored data + summary, NOT a ReviewResult. Suggested params:
    { octokit, owner, repo, prNumber, summary: string, inline: InlineComment[], other: Finding[], usage?: ReviewUsage, verdict?: 'approve'|'comment' }
  Import `InlineComment`, `Finding`, `AnchorResult` types from `./anchor.js` (merged in wave 1). The pipeline (wave 3, task_0d97) will call anchorFindings() and pass `.inline`/`.other` in — this function does NOT call anchorFindings itself.
- event is ALWAYS 'COMMENT' on pulls.createReview regardless of `verdict`. verdict is accepted only so the caller need not strip it; it is ignored (never approve/request-changes).
- comments[] entries: { path, line, side:'RIGHT', start_line?, start_side?, body } where body = inlineComment.message (anchor.ts already folded severity/category/message/suggestion into `.message` via formatMessage). Map InlineComment.message -> createReview comment `body`.
- body = MAGPIE_REVIEW_MARKER + header + summary + 'Other observations' section listing `other[]` as a markdown list with `path:line` + the finding text, so nothing is dropped. + usage footer (reuse formatUsageFooter pattern).
- 422 FALLBACK: if createReview rejects (a line GitHub won't anchor), retry ONCE with comments:[] and the un-anchorable inline findings appended into the body under 'Other observations'; if THAT also throws, fall back to the existing single issues.createComment(publishReview-style). Never throw, never go silent (mirror M1 contract).
- Extend the MinimalIssuesClient test seam to ALSO cover `pulls.createReview` (add a `pulls: { createReview(...) }` member). Keep the existing `issues.createComment` member for the failure/no-findings/fallback paths.
- KEEP publishReview + buildFailureBody + fenceReason UNCHANGED for {ok:false} and the no-findings (findings.length===0) success case (back-compat). publishReviewWithFindings is NEW/additive; it will be unused (dead) until wave 3 wires it — that's expected, tsc must still pass and tests exercise it directly.

GATE before reporting done: `npm test` green in orchestrator workspace + `tsc -p packages/orchestrator/tsconfig.json` clean. Report test output as evidence. Do NOT push or open a PR — tech lead integrates both wave-2 branches into one PR.

---
## REVIEW (tech lead, 2026-07-10) — DONE

Implemented by sonnet subagent. Reviewed + integrated into `m2-wave2`.
- publisher.ts: new `publishReviewWithFindings` (decoupled from ReviewResult — takes anchored `inline`/`other`+summary). One `pulls.createReview({event:"COMMENT"})`; `verdict` accepted-but-ignored. Fallback chain: createReview(comments) → any-throw → retry `comments:[]` with inline folded into "Other observations" → any-throw → `issues.createComment`. Never throws/silent. Shared `renderOtherObservations` renderer for both other[] and folded inline. M1 paths untouched.
- `MinimalIssuesClient` extended with required `pulls.createReview` seam.
- Deliberate deviation accepted: catches ANY createReview rejection (not just status===422) as retry trigger — strictly more defensive, keeps never-throw trivially true.
- Gate: orchestrator 133/133 tests green (incl. comments[] shape, ranges, event=COMMENT under verdict:approve, 422→retry, double-failure→createComment fallback, secret-leak), tsc clean.
