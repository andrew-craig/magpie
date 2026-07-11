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

SCOPE NOTE (custom-gateway reality): the CTO deviation in M4 replaced the planned LiteLLM gateway with a purpose-built, deliberately OpenRouter-ONLY TypeScript proxy (`packages/gateway`, no generic multi-provider abstraction — see PLAN.md §5 deviation box). So multi-provider is NOT "free config" the way it would have been with LiteLLM — it is real new code in our own proxy. Treat this task as speculative until M6 is actually on deck, and get a CTO call on whether the added complexity is wanted before starting (OpenRouter already fronts many upstream models, which may make direct multi-provider unnecessary).

If pursued, the work is:
- `packages/gateway`: generalize the single hardcoded OpenRouter upstream (`upstream.ts` base URL + the injected `Authorization: Bearer <MAGPIE_GATEWAY_OPENROUTER_KEY>`) into a provider registry — per-provider upstream base URL, auth header scheme, and real key (each key held only in the gateway user's env, e.g. MAGPIE_GATEWAY_<PROVIDER>_KEY), selected per request/virtual-key. Keep the OpenAI-compatible client surface and the per-key budget/spend accounting provider-agnostic (cost parsing in `determineCost` may differ per provider — verify each).
- Orchestrator config + `mintGatewayKeyFromConfig`: let config choose provider+model; the reviewer already passes `--provider`/`--model` through to Pi, so confirm Pi supports the chosen provider (and whether the models.json base-URL override trick from M4-C generalizes, or a different per-provider mechanism is needed).
- Keep the security invariants provider-agnostic: real keys live only with the gateway user, containers still get only per-job virtual keys, and magpie-net stays `--internal` with the gateway as the sole reachable egress — the gateway (not the container) is what talks to each provider host, so no container-side allowlist broadening is required; do NOT add direct container egress to provider hosts.
- Update config.example.toml, PLAN.md §5, and docs; verify at least one non-OpenRouter provider (e.g. Anthropic or OpenAI direct) end-to-end, including cost reporting in M5-D's telemetry and all M4-E fail-closed assertions still passing.

Done when: switching provider/model is a config-only change (given the provider's key is present in the gateway env) and a review completes against a second provider with all M4 assertions passing.
