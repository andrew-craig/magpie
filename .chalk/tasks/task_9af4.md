---
id: task_9af4
title: Webhook server + HMAC signature verification
type: task
status: open
priority: 1
labels: []
blocked_by: [task_60fc,task_9c52]
parent: epic_04f9
remote_task_url: null
created_at: 2026-07-05T22:57:02Z
updated_at: 2026-07-05T22:57:02Z
---
Receive GitHub App webhook deliveries on localhost and verify their authenticity before doing anything with the payload.

Context: GitHub posts pull_request events to magpie. Every payload MUST be HMAC-SHA256-verified against the App webhook secret (X-Hub-Signature-256, constant-time compare) BEFORE parsing. @octokit/webhooks implements this correctly — prefer it over hand-rolling. In dev, deliveries arrive via smee.io; in prod via Cloudflare Tunnel (later). This task is just the HTTP receiver.

Scope:
- HTTP server (Fastify or plain node:http) listening on the configured localhost host/port, exposing POST /webhook.
- Wire @octokit/webhooks with the webhook secret from config; reject deliveries that fail signature verification with 400/401 and log the rejection.
- Ensure the RAW body is available to the verifier (don't let a JSON body parser consume it before the HMAC check).
- Emit verified events onto an internal handler seam (emitter/callback) that event filtering will subscribe to. Keep filtering/queueing OUT of this task.
- Basic health endpoint (GET /healthz) is a nice-to-have.

Acceptance criteria:
- A correctly signed test delivery is accepted and surfaced to the handler seam.
- A tampered/wrong-signature delivery is rejected without being parsed/acted on.
- Server binds to the configured host/port and logs startup.

Dependencies: task_60fc (scaffolding), task_9c52 (config: secret + host/port).
