---
id: task_7d6c
title: M2-D: reviewer.ts + prompt wiring for report_findings
type: task
status: in_progress
priority: 1
labels: []
blocked_by: []
parent: epic_e6e6
remote_task_url: null
created_at: 2026-07-09T06:34:22Z
updated_at: 2026-07-09T21:14:59Z
---
Wire reviewer.ts to load the report_findings extension, collect its findings file, and return structured findings; update reviewer-prompt.md. HOST-SUBPROCESS model.

SCOPE (reviewer.ts):
- Add report_findings to the --tools allowlist (currently 'read,grep,find,ls' → 'read,grep,find,ls,report_findings'). Add '-e <abs path to packages/review-extension/src/index.ts>' (resolve relative to MODULE_DIR like REVIEWER_PROMPT_PATH). Consider --no-extensions to disable auto-discovery so ONLY our explicit extension loads (avoid picking up host ~/.pi extensions).
- Before spawn: create a per-run tmp findings file path (e.g. os.tmpdir()/magpie-findings-<nonce>.json) and set env.MAGPIE_FINDINGS_PATH to it. This is NOT a MAGPIE_ secret — set it AFTER the MAGPIE_* strip loop (order matters). After Pi exits 0, read+parse the file via task_876d's parseFindings (the trust boundary). Delete the tmp file in a finally.
- New ReviewResult ok-branch shape (ADDITIVE, keep failure branch): { ok:true, summary, findings: Finding[], verdict, usage? }. Populate summary from the parsed file's summary (fall back to Pi's final assistant text if the file/summary is missing). If Pi exits 0 but wrote NO valid findings file → treat as before: {ok:false, reason:'pi did not call report_findings'} (PLAN.md §6: never silent). Keep all existing timeout/abort/spawn-failure paths.
- Update buildPromptPayload trailer + reviewer-prompt.md: instruct the model to finish by calling report_findings EXACTLY ONCE with file:line matching the diff, using the severity/category taxonomy; DROP the 'reply with findings as plain text' instruction.

TESTS: fake pi script writes a findings file → runReview returns parsed findings+summary+verdict; fake pi that exits 0 without writing file → {ok:false}; malformed findings file → {ok:false} (parseFindings rejects); MAGPIE_FINDINGS_PATH survives the MAGPIE_* strip (set after); tmp file cleaned up; existing timeout/abort/exit-nonzero tests still pass. Do NOT invoke real Pi.

Depends on task_ceb4 (extension must exist to point -e at it) + task_876d (parseFindings/Finding type).

---
## TECH-LEAD COORDINATION NOTE (m2-wave2 dispatch, 2026-07-10)

Assigned to a sonnet subagent in a worktree off branch `m2-wave2`. Runs in parallel with task_6fa4 (publisher). Files are DISJOINT: this task owns `reviewer.ts`, `reviewer-prompt.md`, `reviewer.test.ts`, plus a 1-line compile-fix to `pipeline.ts` (below). Publisher owns `publisher.ts`/`publisher.test.ts`. No shared edits except pipeline.ts tooLarge synthetic.

DECISIONS:
- ReviewResult ok-branch: `findings` and `verdict` are REQUIRED (not optional), matching the canonical contract in epic_e6e6. Import `Finding` from `./findings.js`.
- Because findings/verdict are required, `pipeline.ts`'s tooLarge synthetic `{ ok:true, summary }` no longer compiles. Apply the MINIMAL fix there: add `findings: [], verdict: "comment"` to that synthetic object ONLY, purely to keep tsc green. Do NOT otherwise touch pipeline.ts — the real anchor+inline wiring is task_0d97 (wave 3).
- Import `parseFindings`/`Finding` from `./findings.js` (already merged in wave 1). anchor.ts re-exports them too but findings.js is the source.
- Extension load: `-e` points at the extension SOURCE `packages/review-extension/src/index.ts` resolved relative to MODULE_DIR (same pattern as REVIEWER_PROMPT_PATH: `join(MODULE_DIR, "..","..","..","packages","review-extension","src","index.ts")`). Add `--no-extensions` to prevent host ~/.pi auto-discovery. (These paths are only exercised live in wave 3; wave-2 tests use fake-pi and never load the real extension.)
- Tests use the existing writeFakePi seam (reviewer.test.ts) — the fake script writes JSON to process.env.MAGPIE_FINDINGS_PATH to simulate the extension.

GATE before reporting done: `npm test` green in orchestrator workspace + `tsc -p packages/orchestrator/tsconfig.json` clean. Report test output as evidence. Do NOT push or open a PR — tech lead integrates both wave-2 branches into one PR.
