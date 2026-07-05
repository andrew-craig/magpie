---
id: task_1a13
type: task
title: "smee.io dev relay setup"
status: open
priority: medium
parent: epic_1a01
depends_on: [task_1a12]
created: 2026-07-05
---

# smee.io dev relay setup

Let GitHub webhooks reach the local webhook server during development without a
public inbound port or the Cloudflare Tunnel (which lands in a later milestone).

## Context
`smee.io` gives a public channel URL that forwards deliveries to a localhost
endpoint via an outbound client. Set the GitHub App's webhook URL to the smee
channel in dev; the `smee-client` forwards to `http://localhost:<port>/webhook`.

## Scope
- Add `smee-client` (dev dependency) and a script (e.g. `npm run dev:smee`) that
  forwards a configurable smee channel URL to the local `/webhook` path/port.
- Document the dev setup: create a smee channel, set it as the App's webhook URL,
  run the relay alongside the orchestrator.
- Keep this dev-only — no smee in production paths.

## Acceptance criteria
- Running the relay + orchestrator locally, a PR event on the test repo reaches
  the local `/webhook` and passes signature verification.
- The smee channel URL is configurable (env or config), not hard-coded.

## Dependencies
- task_1a12 (webhook server must exist to forward to)
