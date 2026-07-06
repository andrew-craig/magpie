---
id: task_9c52
title: Configuration loading — config.example.toml + typed loader
type: task
status: closed
priority: 1
labels: []
blocked_by: []
parent: epic_04f9
remote_task_url: null
created_at: 2026-07-05T22:56:49Z
updated_at: 2026-07-06T03:34:17Z
---
Provide a single typed config object the rest of the orchestrator reads from.

Context: Magpie is configured via a TOML file (config.example.toml committed as the template; real config.toml is git-ignored). Secrets that don't belong in TOML (webhook secret, provider API key, GitHub App private key contents) may come from env vars — decide and document which.

Scope:
- config.example.toml with at least the fields M1 needs:
  - GitHub App: app_id, private_key_path (or env), webhook_secret (or env).
  - LLM provider/model: provider base URL + model name; provider API key via env for now (LiteLLM gateway arrives in M4).
  - Server: listen host/port.
  - Limits: job timeout (default 10 min), concurrency (default 2), diff-size cap (~4k changed lines).
  - repo_allowlist: list of owner/repo magpie may auto-review.
  - Work directory (default /var/lib/magpie/work or a dev-friendly override).
- A loader module that parses the TOML, validates required fields, applies defaults, resolves env-var-backed secrets, and exports a typed config object. Fail fast with a clear error if a required field/secret is missing.

Acceptance criteria:
- Loading a valid config returns a fully typed object with defaults applied.
- Missing required fields/secrets produce a clear, actionable error at startup.
- config.example.toml documents every field with a comment.

Dependencies: task_60fc (project scaffolding).

## Review (tech lead, 2026-07-06)

Implemented by Sonnet subagent, reviewed and independently verified by lead.

- `config.example.toml`: every field commented with purpose/default/required; env-secret contract (MAGPIE_WEBHOOK_SECRET, MAGPIE_LLM_API_KEY, MAGPIE_GITHUB_PRIVATE_KEY) documented in header.
- `packages/orchestrator/src/config.ts`: smol-toml + zod v4, strict schemas, defaults applied, aggregated ConfigError naming each bad field/env var. Private key resolved from env (priority) or PEM path.
- Verified: `npm run build` clean, `npm test` 11/11 passing (re-run by reviewer).

Deferred/flagged for later tasks:
- `Config.secrets` serializes via JSON.stringify — add redaction (toJSON) before any config logging lands.
- `private_key_path` / config path resolve against process.cwd(), not the config file dir — confirm semantic when systemd unit is written (M5).
- zod v4 `.prefault()` used for section defaults — do not downgrade to zod v3.
