---
id: task_bcff
title: .env file support for orchestrator secrets
type: task
status: closed
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-07-06T10:40:20Z
updated_at: 2026-07-06T10:51:42Z
---

Let operators supply the orchestrator's environment secrets via an optional
`.env` file instead of exporting them by hand.

## Changes
- `packages/orchestrator/package.json`: `dev`/`start` load a repo-root `.env`
  via Node's built-in `--env-file-if-exists=../../.env` (no dotenv dependency).
- `.env.example`: template documenting `MAGPIE_WEBHOOK_SECRET` and
  `MAGPIE_LLM_API_KEY`. The GitHub App private key stays a `.pem` on disk
  referenced by `github.private_key_path` (not in `.env`).
- `.gitignore`: `!.env.example` so the template is tracked while `.env` /
  `.env.*` / `*.pem` / `config.toml` stay ignored.
- `README.md`: documents the config vs. secrets split and the `.env` convention.

## Review
- Workspace scripts run with cwd = `packages/orchestrator/`, so the flag
  targets `../../.env` (repo root, next to `config.toml`). Verified the exact
  flag loads both vars, and that a missing `.env` is a no-op (app still starts).
- `config.ts` reads these from `process.env` at load time, so no code change
  was needed. `npm test` green (28 passed). In production, supply the vars via
  a systemd `EnvironmentFile=` rather than committing anything.
