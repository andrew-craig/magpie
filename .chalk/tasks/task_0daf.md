---
id: task_0daf
title: PR diff generation
type: task
status: in_progress
priority: 1
labels: []
blocked_by: []
parent: epic_04f9
remote_task_url: null
created_at: 2026-07-05T22:57:46Z
updated_at: 2026-07-07T09:16:37Z
---
Compute the unified diff of the PR from the checked-out workspace, to feed to Pi as the review input.

Context: The reviewer prompt (Pi runner task) needs the PR changes: the unified diff plus the changed-file list. For M1 the full-PR diff (base...head) is sufficient; incremental before...after review is a later milestone. Also enforce the diff-size cap from config (~4k changed lines) — above it, skip or summarize-only.

Scope:
- From the workspace, determine the merge-base of the PR head against the base branch and produce the unified diff (git diff <base>...<head> semantics) plus a changed-file list.
- Return a structured result: diff text, changed files, and total changed-line count.
- Apply the diff-size cap: if changed lines exceed the configured limit, flag the job as too-large so downstream can post a summary-only/skipped notice instead of running a full review.
- Keep output shape simple and typed so the Pi runner can consume it directly.

Acceptance criteria:
- For a sample PR checkout, returns the correct unified diff and changed-file list.
- Changed-line count is computed and the cap is enforced (over-cap path is distinguishable, not a crash).

Dependencies: task_ada6 (needs the checked-out workspace).

## Design decision (tech-lead, 2026-07-07)

Base side of the diff comes from the **GitHub API**, not local git. Rationale:
the workspace checkout only fetches `refs/pull/{N}/head` (blobless, no base
branch), and the base sha/ref isn't plumbed through the filter→JobDescriptor,
so a local three-dot `git diff` isn't computable without new plumbing + a
second authenticated fetch. The API path is simpler and needs no workspace.

Consequence / deviation from original scope: this unit no longer depends on
the checked-out workspace at all. Acceptance criterion "for a sample PR
*checkout*" is met instead against a mocked Octokit returning a known diff +
files list (offline, same spirit as workspace.test.ts / github.test.ts).

## Plan

- [ ] New module `packages/orchestrator/src/diff.ts` with a typed result:
      `{ diff: string | null; changedFiles: string[]; changedLineCount: number; tooLarge: boolean }`.
- [ ] `computePrDiff({ octokit, owner, repo, prNumber, maxDiffLines })`:
      - `octokit.rest.pulls.listFiles` (paginated) → changedFiles (filenames)
        and changedLineCount (Σ additions+deletions across files).
      - Cap check: `tooLarge = changedLineCount > maxDiffLines`.
      - If NOT tooLarge: fetch the unified diff via
        `octokit.rest.pulls.get({..., mediaType:{format:"diff"}})` (data is the
        raw diff string — cast). If tooLarge: short-circuit, `diff = null`
        (don't fetch a huge diff we won't use).
- [ ] Accept an injected `Octokit` (dependency injection, like github.ts) — do
      NOT mint a token inside this module. Wiring into the job pipeline is a
      later task.
- [ ] Unit tests `diff.test.ts` with a hand-rolled fake Octokit (offline):
      under-cap → correct diff + files + count, tooLarge=false; over-cap →
      tooLarge=true, diff=null, files+count still populated, no crash; empty
      diff / zero-file edge case sane.
- [ ] `npm run build` clean; `npm test` green.

## Notes

octokit quirk: `pulls.get` with `mediaType:{format:"diff"}` returns the diff
string in `response.data` even though the static type says the PR object —
cast via `as unknown as string`.
