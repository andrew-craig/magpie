---
id: task_a193
title: M5-B: incremental re-review on synchronize — review only the before...after range
type: task
status: in_progress
priority: 2
labels: []
blocked_by: []
parent: epic_d6c1
remote_task_url: null
created_at: 2026-07-10T21:52:09Z
updated_at: 2026-07-12T10:05:14Z
---
Wave 1 (parallel with M5-A). PLAN.md §7 re-review scope.

- On synchronize events, use the payload's before/after SHAs to compute the incremental diff (GitHub compare API before...after) instead of re-reviewing the full PR diff, so a small follow-up push doesn't re-review (and re-bill) the whole PR.
- Guard the edge cases: force-push where before is unreachable, before...after empty (e.g. rebase-only), and the existing head-SHA-mismatch race guard from the hardening pass must keep working — fall back to the full PR diff whenever the incremental range is unavailable or suspect.
- The diff-size cap applies to the incremental range; keep the existing behaviour above the cap.
- Prompt should tell the reviewer this is an incremental update to an already-reviewed PR (full changed-file list still available as context).

Done when: a synchronize after an initial review sends only the new range to Pi (observable in logs/prompt), with a clean fallback to full-diff when the range can't be resolved.

## Plan

Branch: `m5-incremental-rereview` (off main).

Design decision — **use the incremental range only for a clean fast-forward** (`compare.status === "ahead"`, i.e. `before` is an ancestor of `after`). Every other case — `diverged`/`behind`/`identical` (rebase, revert, no-op force-push), `before` unreachable (404), empty file set, or any compare API error — falls back to the full PR diff. This single rule covers all the edge cases the task lists cleanly.

- [x] `diff.ts`: extracted `listPrChangedFiles()` (shared) + added `computeIncrementalDiff()` using `repos.compareCommitsWithBasehead` (`before...after`). Returns `{available:true, result: PrDiffResult}` for a clean fast-forward (status ahead + non-empty files), else `{available:false, reason}`. Size-cap applies to the range → `tooLarge` flows through unchanged. Guards zero/missing SHAs and `before === after` before the API call.
- [x] `pipeline.ts`: synchronize (`job.before && job.after`) tries `computeIncrementalDiff`; on `available` uses it + `listPrChangedFiles` for full-PR reviewer context, `incremental=true`, logs `incremental-diff`. On `!available` logs `incremental-diff-fallback` (+reason) and uses `computePrDiff`. Non-synchronize unchanged. HEAD VERIFY race guard unchanged. `incremental` threaded to `runReview`; tooLarge summary reworded for the incremental case.
- [x] `reviewer.ts`: `incremental?: boolean` on `RunReviewParams` + `buildPromptPayload`; when true, prepends a TRUSTED notice (outside the untrusted fence) telling Pi the diff is only the new range and `<CHANGED_FILES>` is whole-PR context.
- [x] Tests: `diff.test.ts` +14 (ahead-usable, over-cap-skip, diverged/behind/identical/undefined→unavailable, compare-error→unavailable, empty-files→unavailable, zero-sha + before==after guards without API call, listPrChangedFiles); `pipeline.test.ts` +3 (synchronize sends only range + full file list + notice, verified via captured Pi stdin & `incremental-diff` log; fallback path; non-sync untouched); `reviewer.test.ts` +1 (notice present/absent + placed before fence).
- [x] `npm run build` (tsc) clean; `npm test` green (orchestrator 205, review-extension 11). No lint script in repo; tsc is the type-check.

## Review

Implemented conservatively: the incremental range is used ONLY for a clean fast-forward (`compare.status === "ahead"`). Every ambiguous case — rebase/force-push (`diverged`), revert (`behind`), no-op (`identical`), `before` GC'd away (404), empty file set, zero/missing SHAs — falls back to the full PR diff, so we never silently review a wrong/partial slice. This single rule cleanly covers all the edge cases the task enumerated.

Observability (task "Done when"): the incremental path emits an `incremental-diff` log event; the fallback emits `incremental-diff-fallback` with the reason. The pipeline test additionally proves only the range diff (not the whole-PR diff) reaches Pi's stdin, that the whole-PR file list is still present as context, and that the incremental notice is included.

Verification: the pipeline tests drive the full `runJob` flow end-to-end against a real fake-`pi` subprocess and assert on its actually-captured stdin — this is the offline e2e exercise for this webhook-driven path (no live GitHub needed).

Out of scope (separate M5 work per PLAN.md §7): the `<!-- magpie:reviewed:<sha> -->` hidden marker and GraphQL `minimizeComment` comment-minimization — this task is only the incremental review-scope half.

Not merged/opened yet — awaiting review of the branch `m5-incremental-rereview`.
