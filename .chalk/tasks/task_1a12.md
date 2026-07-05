---
id: task_1a12
type: task
title: "Webhook server + HMAC signature verification"
status: open
priority: high
parent: epic_1a01
depends_on: [task_1a10, task_1a11]
created: 2026-07-05
---

# Webhook server + HMAC signature verification

Receive GitHub App webhook deliveries on localhost and verify their authenticity
before doing anything with the payload.

## Context
GitHub posts `pull_request` events to magpie. Every payload MUST be
HMAC-SHA256-verified against the App's webhook secret (`X-Hub-Signature-256`,
constant-time compare) **before parsing**. `@octokit/webhooks` implements this
correctly — prefer it over hand-rolling. In dev, deliveries arrive via smee.io
(task_1a13); in prod via Cloudflare Tunnel (later milestone). This task is just
the HTTP receiver.

## Scope
- HTTP server (Fastify or plain `node:http`) listening on the configured
  localhost host/port, exposing `POST /webhook`.
- Wire `@octokit/webhooks` with the webhook secret from config; reject deliveries
  that fail signature verification with 400/401 and log the rejection.
- Ensure the **raw body** is available to the verifier (don't let a JSON body
  parser consume it before HMAC check).
- Emit verified events onto an internal handler seam (an emitter / callback) that
  event filtering (task_1a14) will subscribe to. Keep filtering/queueing OUT of
  this task.
- A basic health endpoint (`GET /healthz`) is a nice-to-have.

## Acceptance criteria
- A correctly signed test delivery is accepted and surfaced to the handler seam.
- A tampered/wrong-signature delivery is rejected without being parsed/acted on.
- Server binds to the configured host/port and logs startup.

## Dependencies
- task_1a10 (scaffolding), task_1a11 (config: secret + host/port)
