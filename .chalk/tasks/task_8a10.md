---
id: task_8a10
title: M5-D: cost logging + per-job telemetry
type: task
status: open
priority: 2
labels: []
blocked_by: []
parent: epic_d6c1
remote_task_url: null
created_at: 2026-07-10T21:52:34Z
updated_at: 2026-07-10T21:52:34Z
---
Wave 1 (parallel; independent of M5-B/C). PLAN.md §6 post-hoc cost logging.

- The reviewer already parses Pi's NDJSON usage events (M1 reviewer.ts) and the PR comment carries a usage footer; extend this into durable per-job telemetry: structured log line (and/or an append-only JSONL under /var/lib/magpie) per job with repo, PR, head SHA, outcome, wall-clock, tokens in/out, and cost.
- Cross-check reported usage against the gateway: LiteLLM tracks spend per virtual key (M4-B), so log the key's final spend alongside Pi's self-reported usage — the gateway number is the authoritative one for cost.
- Log budget exhaustion and timeout kills distinctly so runaway-cost patterns are visible.
- Keep it greppable: one summary line per job is the interface; no dashboards in scope.

Done when: after any review (success or failure) a single structured record exists with cost + outcome, and gateway-reported spend is included when the gateway is in play.
