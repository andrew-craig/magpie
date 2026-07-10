---
id: task_9c9d
title: M6-D: multi-provider support beyond OpenRouter
type: task
status: open
priority: 3
labels: []
blocked_by: []
parent: epic_3c41
remote_task_url: null
created_at: 2026-07-10T21:53:33Z
updated_at: 2026-07-10T21:53:33Z
---
PLAN.md milestone 6. Make the LLM provider configurable rather than OpenRouter-only.

- The gateway is the natural seam: LiteLLM already speaks many providers, so this is mostly gateway/litellm.config.yaml model routing + config schema (provider, model, per-provider key env vars held by the gateway user only) rather than orchestrator code.
- Keep the security invariants provider-agnostic: real keys live only with the gateway user, containers still get only per-job virtual keys, and the gateway's outbound allowlist (M4-A) must extend to exactly the configured provider hosts — no broadening beyond them.
- Update config.example.toml and docs; verify at least one non-OpenRouter provider (e.g. Anthropic or OpenAI direct) end-to-end, including cost reporting in M5-D's telemetry.

Done when: switching provider/model is a config-only change and a review completes against a second provider with all M4 assertions passing.
