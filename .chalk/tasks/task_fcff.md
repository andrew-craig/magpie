---
id: task_fcff
title: Cloudflare Tunnel (cloudflared) ingress scaffolding
type: task
status: in_progress
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-07-06T12:38:58Z
updated_at: 2026-07-06T12:39:19Z
---


## Context
Production webhook ingress (PLAN.md M5), pulled forward now that online build is unblocked and CTO confirmed a Cloudflare domain exists. Supersedes smee (task_d4a8) for anything beyond local dev; combined with a registered GitHub App, unblocks live E2E (task_9b61).

Design: outbound-only named tunnel, hostname `magpie.<domain>` -> `http://localhost:8787/webhook` (orchestrator binds 127.0.0.1:8787, keep it loopback). HMAC (server.ts) is the auth gate — NO Cloudflare Access in front of /webhook (would block GitHub's unauthenticated POSTs). Host is aarch64 (Raspberry Pi).

Deliverables: scripts/setup-cloudflared.sh (install arm64 .deb, guided tunnel create/route, render config from template), systemd unit, config.yml template with hostname placeholder, runbook docs. Dispatched to sonnet subagent in worktree.
