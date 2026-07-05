---
id: task_1a10
type: task
title: "Project scaffolding — npm workspaces + orchestrator package"
status: open
priority: high
parent: epic_1a01
depends_on: []
created: 2026-07-05
---

# Project scaffolding — npm workspaces + orchestrator package

Stand up the repository skeleton so all later work has somewhere to live.

## Context
Magpie is a TypeScript/Node project using npm workspaces. Milestone 1 only needs
the `orchestrator` package; other packages (`review-extension`) come later.

## Scope
- Root `package.json` with npm **workspaces** (`packages/*`).
- `packages/orchestrator/` with its own `package.json`, `tsconfig.json`, and a
  `src/` entrypoint (`src/index.ts`).
- TypeScript configured for Node 22 (ES modules), with a `build` and a
  `dev`/`start` script. Pick a runner (e.g. `tsx`) for dev.
- Base dev tooling: `typescript`, `@types/node`. Add a lint/format setup if
  cheap, otherwise defer.
- `.gitignore` for `node_modules`, build output, and local secrets.
- Do NOT add the sandbox/gateway files yet (docker/, gateway/, systemd/); those
  belong to later milestones.

## Acceptance criteria
- `npm install` at the repo root succeeds and wires the workspace.
- `npm run build` (or equivalent) compiles the orchestrator with no errors.
- `npm run dev` starts the placeholder entrypoint.

## Dependencies
None — this is the foundation task.
