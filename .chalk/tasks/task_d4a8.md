---
id: task_d4a8
title: smee.io dev relay setup
type: task
status: open
priority: 2
labels: []
blocked_by: []
parent: epic_04f9
remote_task_url: null
created_at: 2026-07-05T22:57:14Z
updated_at: 2026-07-06T06:05:21Z
---
Let GitHub webhooks reach the local webhook server during development without a public inbound port or the Cloudflare Tunnel (which lands in a later milestone).

Context: smee.io gives a public channel URL that forwards deliveries to a localhost endpoint via an outbound client. Set the GitHub App webhook URL to the smee channel in dev; smee-client forwards to http://localhost:<port>/webhook.

Scope:
- Add smee-client (dev dependency) and a script (e.g. npm run dev:smee) that forwards a configurable smee channel URL to the local /webhook path/port.
- Document the dev setup: create a smee channel, set it as the App webhook URL, run the relay alongside the orchestrator.
- Keep this dev-only — no smee in production paths.

Acceptance criteria:
- Running the relay + orchestrator locally, a PR event on the test repo reaches the local /webhook and passes signature verification.
- The smee channel URL is configurable (env or config), not hard-coded.

Dependencies: task_9af4 (webhook server must exist to forward to).
