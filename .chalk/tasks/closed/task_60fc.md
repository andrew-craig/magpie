---
id: task_60fc
title: Project scaffolding — npm workspaces + orchestrator package
type: task
status: closed
priority: 1
labels: []
blocked_by: []
parent: epic_04f9
remote_task_url: null
created_at: 2026-07-05T22:56:41Z
updated_at: 2026-07-06T00:31:59Z
---
Stand up the repository skeleton so all later work has somewhere to live.

Context: Magpie is a TypeScript/Node project using npm workspaces. Milestone 1 only needs the orchestrator package; review-extension comes later.

Scope:
- Root package.json with npm WORKSPACES (packages/*).
- packages/orchestrator/ with its own package.json, tsconfig.json, and a src/ entrypoint (src/index.ts).
- TypeScript configured for Node 22 (ES modules), with build and dev/start scripts. Pick a dev runner (e.g. tsx).
- Base dev tooling: typescript, @types/node. Add lint/format if cheap, else defer.
- .gitignore for node_modules, build output, local secrets.
- Do NOT add sandbox/gateway files yet (docker/, gateway/, systemd/) — later milestones.

Acceptance criteria:
- npm install at repo root succeeds and wires the workspace.
- npm run build compiles the orchestrator with no errors.
- npm run dev starts the placeholder entrypoint.

Dependencies: none — foundation task.

## Review (tech lead)
Reviewed by tech lead; implemented by sonnet subagent.
- Files: root package.json (npm workspaces, type=module), packages/orchestrator/{package.json,tsconfig.json,src/index.ts}, .gitignore, package-lock.json.
- Acceptance criteria independently re-verified from a clean rebuild:
  1. npm install wires workspace — node_modules/@magpie/orchestrator symlink confirmed.
  2. npm run build — tsc clean, exit 0, dist/ produced.
  3. npm run dev (and start) — prints "magpie orchestrator starting", exit 0.
- Node v22.22.2; ESM/NodeNext, strict TS. Scope-clean: no docker/gateway/systemd/review-extension (correctly deferred).
- Deferred: ESLint/Prettier (per task, not cheap enough to add now).
Verdict: APPROVED.
