---
id: task_948f
title: M5-C review fix: verify bot author in readReviewState (marker-spoof dedup DoS)
type: task
status: closed
priority: 2
labels: []
blocked_by: []
parent: epic_d6c1
remote_task_url: null
created_at: 2026-07-13T07:42:20Z
updated_at: 2026-07-13T08:10:06Z
---

## Bug

`readReviewState` (rereview.ts) attributed a comment/review to Magpie purely
by checking `MAGPIE_REVIEW_MARKER` in the body — a public literal any PR
commenter can forge. A malicious PR author could post
`<!-- magpie-review --><!-- magpie:reviewed:<current-head-sha> -->` as their
own issue comment and cause pipeline.ts's dedup check
(`lastReviewedSha === job.headSha`) to silently skip reviewing that PR — a
DoS against the bot triggerable via the exact adversarial-input channel
Magpie exists to defend against.

## Plan

- [x] Add `getAppBotLogin` (+ `getAppBotLoginFromConfig` convenience
      wrapper) to `github.ts`: app-JWT-authenticated Octokit ->
      `apps.getAuthenticated()` -> `` `${slug}[bot]` ``, memoized at module
      scope (resolved at most once per process; a failed resolution is not
      cached so a later call can retry).
- [x] Thread a required `botLogin` param into `readReviewState`
      (rereview.ts). A comment/review now counts as Magpie's own only if
      `user.type === "Bot" && user.login === botLogin && bodyHasMarker`.
      Applied to BOTH the issue-comment filter and the review filter (the
      latter feeds `magpieReviewIds`, hardening the inline-comment/minimize
      attribution path too).
- [x] Graceful degradation: an empty/unresolvable `botLogin` makes
      `readReviewState` trust nothing (`{ lastReviewedSha: undefined,
      minimizableNodeIds: [] }`), short-circuiting before it even paginates.
      pipeline.ts resolves the bot login inside the SAME try/catch that
      already wraps `readReviewState`, so a resolution failure also falls
      back to that same safe default — never a wrongly-skipped review.
- [x] Update `rereview.test.ts` fixtures with `user: {login, type}`; add
      spoof / wrong-bot / degradation tests.
- [x] Update `github.test.ts` with a `getAppBotLogin` unit test (resolves
      `<slug>[bot]`, memoizes across two calls).
- [x] Update `pipeline.test.ts`: inject a fixed `getBotLogin` fake at every
      `createReviewPipeline` call site (37) and give the M5-C
      `magpieIssueComment`/`magpieReview` fixtures a matching `user` so the
      existing dedup/minimize assertions stay green.

## Result

`npm test` (all 3 workspaces): gateway 55/55, orchestrator 245/245 (up from
226 — 19 new tests), review-extension 11/11, all green. `npm run build`
(tsc) clean. `npx biome check` on all 6 changed source files: exit 0.

Files touched: `packages/orchestrator/src/github.ts`,
`packages/orchestrator/src/rereview.ts`, `packages/orchestrator/src/pipeline.ts`,
and their three `*.test.ts` files. Committed to `m5-rereview-dedup`; not
pushed, PR untouched, task left `in_progress` per the brief — tech lead to
review, close, and handle the live deploy/PR.

## Tech-lead review (2026-07-13) — ACCEPTED
Diff reviewed (github.ts + rereview.ts + pipeline.ts) + suite re-run independently: 311 tests (gw 55 / orch 245 / rev-ext 11), tsc clean, biome exit 0. `isMagpieAuthored` requires `user.type==="Bot" && user.login===botLogin` + marker, applied to BOTH issue-comment and review filters (hardens minimize path too); empty botLogin short-circuits to empty state; getAppBotLogin uses app-JWT (separate Octokit), memoizes success only, no unhandled rejection. pipeline resolves botLogin + readReviewState under one try/catch → fails toward doing-the-review. Closes the marker-spoof dedup DoS magpie's own PR#37 review found.
