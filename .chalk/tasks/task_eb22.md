---
id: task_eb22
title: M4-A: LiteLLM gateway service — own user, real provider key, OpenAI-compatible endpoint
type: task
status: open
priority: 1
labels: []
blocked_by: []
parent: epic_6730
remote_task_url: null
created_at: 2026-07-10T21:50:44Z
updated_at: 2026-07-10T21:50:44Z
---
Wave 1. Stand up the host-side LiteLLM proxy per PLAN.md §5.

- gateway/litellm.config.yaml: model routing to OpenRouter, real OPENROUTER_API_KEY held only here (env/file readable by the gateway user only), virtual-key/budget support enabled (master key + key DB as LiteLLM requires).
- Runs on the host as its OWN unprivileged user, outside the container's blast radius; listens only on the address the magpie-net bridge will reach (plus localhost for the orchestrator's key-management calls) — never 0.0.0.0.
- Pin the LiteLLM version; document how to install/run it (systemd unit itself can land in M5, but the service must be runnable and documented now).
- Optional defense-in-depth: SNI/domain allowlist limiting the gateway's own outbound to the provider host (openrouter.ai), noted or implemented.

Done when: gateway starts under its own user, answers an OpenAI-compatible chat completion using the real key, and the real key is readable only by the gateway user.
