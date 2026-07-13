---
id: task_ecbf
title: M7-4: Config portability — delete pinned IPs/subnet; gateway address becomes a socket path; keep secret split
type: task
status: open
priority: 2
labels: [distribution]
blocked_by: []
parent: epic_0162
remote_task_url: null
created_at: 2026-07-12T13:07:35Z
updated_at: 2026-07-13T13:23:18Z
---
Remove the pinned network contract from config now that the reviewer has no network (Design D). Delete container_base_url=172.31.99.1:4000 and the container.network setting; the gateway proxy plane address becomes a unix SOCKET PATH (per-job or a fixed dir, e.g. /run/magpie/jobs), not a bridge IP. Remove the 172.31.99.0/24 references from config.example.toml and its comments. Consolidate non-secret config into one clear place, but KEEP the deliberate secret split (webhook secret, gateway master key, real OpenRouter key, GitHub PEM must not all be co-readable) — do NOT collapse all secrets into one file. Document the openssl rand -hex 32 master-key step (shared by orchestrator + gateway).
