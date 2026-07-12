---
id: task_d8b1
title: M7-6: Onboarding docs — QUICKSTART.md, generated master key, secret consolidation
type: task
status: open
priority: 2
labels: [distribution,docs]
blocked_by: []
parent: epic_0162
remote_task_url: null
created_at: 2026-07-12T13:07:35Z
updated_at: 2026-07-12T13:34:30Z
---
Docs-only onboarding (no App Manifest flow this round). QUICKSTART.md for the host-service deployment: install prerequisites (Docker for the reviewer image, node, git) -> run the install script (M7-3) -> fill secrets, incl. generating the shared gateway master key with 'openssl rand -hex 32' (same value in the orchestrator + gateway env files) -> register the GitHub App (clear step-by-step: permissions contents:read + pull_requests:read/write, subscribe pull_request events, webhook URL + secret, App ID, download .pem) -> point the webhook at your ingress (M7-5) -> open a PR. Consolidate NON-secret config, but keep the deliberate secret split (see M7-4) — 'fewer files', not 'all secrets in one file'.
