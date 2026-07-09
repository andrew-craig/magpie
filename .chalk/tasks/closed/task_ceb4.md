---
id: task_ceb4
title: M2-A: report_findings Pi extension package
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
Create packages/review-extension/ — a Pi extension defining the single report_findings tool (tool-call-as-structured-output pattern; Pi has no JSON-schema output mode). HOST-SUBPROCESS model (no container).

SCOPE:
- New npm workspace package packages/review-extension/ (name @magpie/review-extension). package.json declares deps: @earendil-works/pi-coding-agent, typebox, @earendil-works/pi-tui (match versions Pi 0.80.3 ships; see /home/operator/.nvm/.../pi-coding-agent/examples/extensions/structured-output.ts as the reference pattern).
- src/index.ts: export default (pi: ExtensionAPI) => pi.registerTool(reportFindingsTool). Define via defineTool with a Typebox schema matching the CANONICAL FINDINGS CONTRACT in epic_e6e6 EXACTLY (findings[]{path,line,end_line?,severity enum,category,message,suggestion?}, summary, verdict enum).
- execute(): write JSON.stringify({findings,summary,verdict}) to the path in process.env.MAGPIE_FINDINGS_PATH (use node:fs/promises writeFile; create parent dir if needed). If the env var is unset, write to './magpie-findings.json' in cwd and log a warning to stderr. Return { content:[{type:'text',text:'Recorded N findings'}], terminate:true } so the run ends without an extra LLM turn.
- promptSnippet/promptGuidelines instruct: call report_findings EXACTLY ONCE as the final action.
- Extension loads via 'pi -e <path>' — Pi transpiles .ts directly, NO build step. But it MUST typecheck: add a tsc --noEmit check (extends root tsconfig or its own). Add to root 'test'/build as appropriate.

TESTS (vitest, colocated): (1) execute writes a valid JSON file to MAGPIE_FINDINGS_PATH (use a tmp path) and the parsed content round-trips a sample findings object; (2) execute returns terminate:true; (3) schema rejects a bad severity / missing required field. Do NOT invoke real Pi or an LLM.

Leaf task — no deps. Coordinate on the CONTRACT only; task_B owns the orchestrator-side zod mirror.

## TECH-LEAD REVIEW (2026-07-09) — APPROVED

Branch `m2a-review-extension` (commit 79fc5f1). Reviewed code + independently re-ran in worktree: `tsc --noEmit` clean, 8/8 vitest pass.

Files (all under `packages/review-extension/`, new `@magpie/review-extension` workspace): `package.json`, `tsconfig.json`, `src/index.ts` (the report_findings tool), `src/index.test.ts`.

Contract match CONFIRMED against M2-B's zod: Typebox schema has path/line/end_line?/severity(blocking|important|nit)/category/message/suggestion? + top-level findings[]/summary/verdict(approve|comment). `execute()` writes `JSON.stringify({findings,summary,verdict})` to MAGPIE_FINDINGS_PATH (mkdir -p parent), falls back to ./magpie-findings.json + stderr warning if unset, returns `terminate:true`. Shape written matches exactly what parseFindings expects.

Deps pinned against Pi 0.80.3's own manifests: pi-coding-agent ^0.80.3, pi-tui ^0.80.3, typebox 1.1.38 (exact, matching Pi's pin), vitest ^4.1.9.

Deviation (sound): `execute()` also returns a `details:{findingsCount,path}` field — required by `AgentToolResult<T>`'s type (not optional in 0.80.3); reference example does the same. Omitting it fails tsc.

Process note (no lasting impact): agent briefly ran setup against the shared /home/operator/magpie checkout, created a stray branch, caught it before writing files, reverted to clean `main`, redid work in its assigned worktree. Verified: main repo clean, no stray branches.
