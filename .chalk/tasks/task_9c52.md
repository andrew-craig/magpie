---
id: task_9c52
title: Configuration loading — config.example.toml + typed loader
type: task
status: open
priority: 1
labels: []
blocked_by: []
parent: epic_04f9
remote_task_url: null
created_at: 2026-07-05T22:56:49Z
updated_at: 2026-07-06T00:31:59Z
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
