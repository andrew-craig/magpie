---
id: task_ab2f
title: Make draft-PR skipping configurable
type: task
status: closed
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-08-09T13:37:00Z
updated_at: 2026-08-09T13:37:22Z
---

## Plan

filter.ts unconditionally drops any `pull_request` webhook whose `pull_request.draft === true`.
Make that behavior an operator config toggle rather than a hardcoded rule.

- [x] Add `[review] skip_draft_prs` to the config schema (config.ts), default `true` — preserves
      existing behavior for every deployment that doesn't set it.
- [x] Add `Config.review.skipDraftPrs` to the typed `Config` interface + `loadConfig`'s return
      mapping.
- [x] Wire it into `createPullRequestFilter` (filter.ts): only drop a draft PR when
      `config.review.skipDraftPrs` is `true` (defaulting to `true` if the config slice a caller
      passes doesn't include `review` at all, matching the schema default).
- [x] Document the new key in `config.example.toml` and `docs/ARCHITECTURE.md`.
- [x] Update existing full-`Config` test fixtures (repo-config.test.ts, pipeline.test.ts) that
      build a literal `review: { allowApprove }` object, now missing the new required field.
- [x] Add tests: config.ts default + TOML-override coverage, filter.ts "reviews draft PRs when
      skipDraftPrs is false" case.

Deliberately NOT a per-repo `.magpie.toml` knob (unlike `allow_approve`): `.magpie.toml` isn't
resolved until later in the pipeline (after clone), well after `filter.ts` already decided
whether to enqueue the job at all — threading it through would be a materially bigger change for
a toggle with no security consequence, unlike `allow_approve`'s double-gate. A single
operator-level `config.toml` boolean matches what was asked.

## Results

Implemented as planned. `npx tsc --noEmit` on packages/orchestrator clean; full orchestrator
vitest suite (33 files / 535 tests) passes. Diff is 8 files, ~66/-16 lines.
