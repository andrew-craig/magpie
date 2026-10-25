---
id: task_869b
title: Evaluate TypeScript 7 (native tsgo compiler) adoption
type: task
status: open
priority: 2
labels: [deps]
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-10-25T10:51:11Z
updated_at: 2026-10-25T10:51:11Z
---


Follow-up from task_d8d6 / PR #91, which moved to TypeScript 6.0.3 (the last JS-based compiler line). TypeScript 7.0.2 is the native Go port ("tsgo" / Project Corsa), a separate compiler implementation.

## Questions to answer
- Is TS 7's `tsc` a drop-in for our `tsc -p tsconfig.json` builds and `tsc --noEmit` typecheck? Are emit differences acceptable?
- Do vitest 5 and tsx (esbuild-based) still work? They don't use tsc, so they should, but confirm.
- Does Pi run the review-extension `.ts` source directly, and does that have its own TS dependency?
- Are TS-6-deprecated tsconfig options now removed? After PR #91 we set `"types": ["node"]`.
- Is the ecosystem ready: does `@types/*` and any API consumer (e.g. a program that imports `typescript`) need the JS API, which TS 7 may not ship the same way?
- What is the build-time win on the Pi host (arm64)?

## Plan
- [ ] Read the TS 7.0 release notes and breaking changes
- [ ] On a scratch branch, bump `typescript` to ^7 and run the build, `tsc --noEmit` and npm test across all workspaces
- [ ] Compare emitted `dist/` against TS 6 (diff of the JS output)
- [ ] Recommend adopt, wait or hold; if adopting, bump and update CI
