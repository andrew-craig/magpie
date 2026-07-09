---
id: task_876d
title: M2-B: diff-hunk parser + finding anchoring (orchestrator)
type: task
status: closed
priority: 1
labels: []
blocked_by: []
parent: epic_e6e6
remote_task_url: null
created_at: 2026-07-09T06:33:53Z
updated_at: 2026-07-09T13:21:17Z
---
Add orchestrator-side diff anchoring: map each structured finding to a GitHub inline-comment location, or mark it out-of-diff. HOST model, pure functions.

SCOPE (new file packages/orchestrator/src/anchor.ts, plus a shared contract):
- Define the canonical orchestrator-side Finding TYPE + a zod validator parseFindings(raw: string): { ok:true, value: ReviewFindings } | { ok:false, error } matching epic_e6e6's CANONICAL FINDINGS CONTRACT EXACTLY (this is the trust boundary — the findings file is written by an LLM-driven tool, treat as untrusted-shape: validate, never eval). Put the type+zod in anchor.ts (or a small findings.ts it re-exports) so task_C and task_D import from ONE place.
- parseUnifiedDiff(diff: string): produce, per file path, the set of NEW-file line numbers that are commentable per GitHub's rules (added '+' lines AND context ' ' lines on the RIGHT side; deletions are not commentable on the right). Track new-file line numbers from each hunk header (@@ -a,b +c,d @@).
- anchorFindings(diff, findings): return { inline: InlineComment[], other: Finding[] } where InlineComment = { path, line, side:'RIGHT', start_line?, message } for findings whose (path, line[, end_line]) fall on commentable lines; everything else (unknown path, line not in diff, end_line<line) folds into 'other'. For ranged findings validate BOTH line and end_line anchor (GitHub 422s otherwise) — if end_line doesn't anchor, degrade to a single-line comment on 'line' rather than dropping.

TESTS (vitest, colocated, fixture diffs): hunk header parsing incl multiple hunks/files; a finding on an added line anchors; on a context line anchors; on a deleted/absent line folds to other; unknown path folds to other; ranged finding maps to start_line+line; parseFindings rejects malformed JSON and bad enums, accepts a valid sample.

Leaf task — no deps. Owns the orchestrator-side findings contract; task_A mirrors it on the extension side.

## TECH-LEAD REVIEW (2026-07-09) — APPROVED

Branch `m2b-anchor` (commit c4596ff). Reviewed code + independently re-ran in worktree: `tsc` build clean, full orchestrator suite 121/121 pass (23 new tests across findings.test.ts + anchor.test.ts). No regressions.

Files: `src/findings.ts` (canonical Finding/ReviewFindings zod contract + `parseFindings` trust boundary), `src/anchor.ts` (`parseUnifiedDiff` + `anchorFindings`, re-exports findings). Both well-documented.

Exported API surface (downstream tasks import from anchor.ts):
- `parseFindings(raw): {ok:true,value:ReviewFindings}|{ok:false,error}` — try/catch JSON.parse + strict zod, collapses both failure modes.
- `parseUnifiedDiff(diff): Map<path, Set<newLineNum>>` — commentable RIGHT-side lines.
- `anchorFindings(diff, findings): {inline: InlineComment[], other: Finding[]}`.
- `InlineComment = {path, line, side:'RIGHT', start_line?, start_side?, message}`.

Correctness confirmed: GitHub range convention `{start_line: firstLine, line: lastLine}` is correct (multi-line review comments anchor at the LAST line). Diff parser handles multi-file/multi-hunk, `+++ /dev/null`, `--- a/` mislabel guard, `\ No newline` marker, blank context lines.

DESIGN NOTE for downstream (task_6fa4 publisher): `anchorFindings` PRE-RENDERS severity/category/suggestion into `InlineComment.message` (markdown) via internal `formatMessage` — publisher posts `comment.message` VERBATIM, must not re-render. BUT the `other` bucket holds RAW `Finding` objects — publisher renders those itself for the "Other observations" summary section. Asymmetry is intentional; flagged to task_C.

Deviations (all documented in code, all sound): `end_line` NOT enforced >= line at zod level (left to anchor degrade logic); invalid/non-anchoring end_line degrades to single-line rather than dropping; `.strict()` schemas reject unknown props.
