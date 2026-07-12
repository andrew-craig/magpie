---
id: task_d8b1
title: M7-6: Onboarding docs — QUICKSTART.md, single .env, generated master key
type: task
status: open
priority: 2
labels: [distribution,docs]
blocked_by: []
parent: epic_0162
remote_task_url: null
created_at: 2026-07-12T13:07:35Z
updated_at: 2026-07-12T13:07:35Z
---
Docs-only onboarding (no App Manifest flow this round). QUICKSTART.md: clone -> fill one .env -> docker compose up -> register the GitHub App (clear step-by-step: permissions contents:read + pull_requests:read/write, subscribe pull_request events, webhook URL + secret, App ID, download .pem) -> point webhook at ingress -> open a PR. Document generating the shared gateway master key with 'openssl rand -hex 32' set once in the single .env. Consolidate secrets for the container path.
