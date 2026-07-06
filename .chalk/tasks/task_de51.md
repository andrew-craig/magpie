---
id: task_de51
title: config.toml resolution should not depend on process.cwd()
type: task
status: open
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-07-06T11:22:56Z
updated_at: 2026-07-06T11:22:56Z
---

Surfaced in PR #9 review (gemini-code-assist). `config.ts` resolves
`config.toml` relative to `process.cwd()` (default `./config.toml`), but the
npm workspace scripts run with cwd = `packages/orchestrator/`, so
`npm run dev`/`start` would look for `packages/orchestrator/config.toml`
instead of the documented repo-root location. Conversely, running from the
repo root finds `config.toml` but is a different cwd again.

Not a live bug yet: `index.ts` is a placeholder that never calls
`loadConfig`. Address when the entrypoint is wired to the config loader.

## Options
- Resolve `config.toml` by walking up from the entrypoint / package to the
  repo root (e.g. nearest ancestor containing `config.toml` or `package.json`
  with the workspace root), independent of cwd.
- Or pin cwd in the run model (systemd `WorkingDirectory=` + `npm run`
  starting node from the repo root) and document it.
- `MAGPIE_CONFIG` (absolute path) already overrides resolution as an escape
  hatch; make sure the eventual default is coherent with how the service is
  actually launched.

Note: `.env` loading was already made cwd-robust in PR #9 (dual
`--env-file-if-exists=.env --env-file-if-exists=../../.env`); mirror that
robustness for `config.toml`.
