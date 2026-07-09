---
id: task_0d97
title: M2-E: pipeline integration + live e2e verification
type: task
status: open
priority: 1
labels: []
blocked_by: [task_6fa4,task_7d6c]
parent: epic_e6e6
remote_task_url: null
created_at: 2026-07-09T06:34:40Z
updated_at: 2026-07-09T06:34:40Z
---
Integrate the structured-findings flow end-to-end through pipeline.ts and live-verify against a real PR, mirroring the M1 e2e acceptance.

SCOPE (pipeline.ts):
- Thread the new ReviewResult through: on {ok:true} with findings, call task_876d anchorFindings(prDiff.diff, result.findings) then task_6fa4's publishReviewWithFindings (inline review). tooLarge synth-summary path and {ok:false} failure path keep posting the M1 single summary comment (publishReview) unchanged. Keep the one-token-per-job, try/finally workspace cleanup, HEAD-VERIFY, and abort-guard structure intact.
- Ensure pipeline.test.ts's offline fakes cover the new anchor+inline-review path (findings → inline comments) as well as the tooLarge and failure paths.

LIVE E2E (host, real Pi + OpenRouter, like M1): run the orchestrator (npm run dev) against a real synchronize/opened event on andrew-craig/magpie test PR; confirm ONE magpie-reviewer[bot] COMMENT review with inline comments on diff lines + a summary body (with Other observations if any), correct usage footer, workspace cleaned, no duplicate comments/reviews. Capture the run's turns/tokens/cost and the comment/review URLs as evidence in this task file.

Gate: full 'npm test' green + tsc clean across BOTH workspaces before opening the PR.

Depends on task_6fa4 + task_7d6c (final integration).
