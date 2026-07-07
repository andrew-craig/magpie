---
id: task_560a
title: Remove unused buildCloneUrl token-in-URL footgun from github.ts
type: task
status: in_progress
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-07-07T00:01:32Z
updated_at: 2026-07-07T08:40:31Z
---

## Context

Follow-up to PR #10 (task_2941). `workspace.ts` no longer uses
`buildCloneUrl` — that PR moved host-side git auth off the token-in-URL
pattern (tokenless origin + `GIT_TOKEN` env + ephemeral `-c credential.helper`).

`buildCloneUrl` (github.ts) builds `https://x-access-token:<token>@github.com/...`,
i.e. it embeds a live installation token in a plaintext string. It now has no
production caller — leaving it exported is an attractive nuisance: the exact
token-in-URL footgun PR #10 removed, one `import` away from creeping back in.

## Plan

- [x] Confirm no remaining production callers (`grep -rn buildCloneUrl packages/*/src`).
- [x] Remove `buildCloneUrl` from `packages/orchestrator/src/github.ts` and its
      doc comment; check the module-level SECURITY comment that references it.
- [x] Remove its unit tests from `github.test.ts` (the `describe("buildCloneUrl")`
      block + the import).
- [x] Grep for stray `{@link buildCloneUrl}` doc references and drop/repoint them.
- [x] `npm run build` clean; `npm test` green.

## Notes

Deferred from PR #10 to keep that change focused on the reviewed file
(`workspace.ts`). Low risk, low effort.

## Review

Implemented by sonnet subagent on branch `remove-buildcloneurl`; reviewed by tech lead.

- `github.ts`: deleted `buildCloneUrl` + its doc comment; reworded the module-level
  SECURITY comment so it no longer references the removed function (now speaks only
  to the token itself).
- `github.test.ts`: dropped `buildCloneUrl` from the `import` and removed the
  `describe("buildCloneUrl")` block.
- `workspace.test.ts`: reworded the NOTE comment that named `buildCloneUrl`
  (test logic unchanged).
- Post-change `grep -rn buildCloneUrl packages/*/src` returns nothing.
- Verified: `npm run build` clean; `npm test` → 54/54 passing (6 files).
