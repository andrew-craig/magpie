---
id: task_1a11
type: task
title: "Configuration loading — config.example.toml + typed loader"
status: open
priority: high
parent: epic_1a01
depends_on: [task_1a10]
created: 2026-07-05
---

# Configuration loading — config.example.toml + typed loader

Provide a single typed config object the rest of the orchestrator reads from.

## Context
Magpie is configured via a TOML file (`config.example.toml` committed as the
template; the real `config.toml` is git-ignored). Secrets that don't belong in
TOML (webhook secret, provider API key, GitHub App private key contents) may
come from environment variables — decide and document which.

## Scope
- `config.example.toml` with, at minimum, the fields milestone 1 needs:
  - GitHub App: `app_id`, `private_key_path` (or env), `webhook_secret` (or env).
  - LLM provider/model: provider base URL + model name; provider API key via env
    for now (the LiteLLM gateway arrives in milestone 4).
  - Server: listen host/port.
  - Limits: job timeout (default 10 min), concurrency (default 2), diff-size cap
    (~4k changed lines).
  - `repo_allowlist`: list of `owner/repo` magpie is allowed to auto-review.
  - Work directory (default `/var/lib/magpie/work` or a dev-friendly override).
- A loader module that parses the TOML, validates required fields, applies
  defaults, resolves env-var-backed secrets, and exports a typed config object.
  Fail fast with a clear error if a required field/secret is missing.

## Acceptance criteria
- Loading a valid config returns a fully typed object with defaults applied.
- Missing required fields/secrets produce a clear, actionable error at startup.
- `config.example.toml` documents every field with a comment.

## Dependencies
- task_1a10 (project scaffolding)
