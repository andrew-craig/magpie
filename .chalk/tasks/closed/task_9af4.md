---
id: task_9af4
title: Webhook server + HMAC signature verification
type: task
status: closed
priority: 1
labels: []
blocked_by: []
parent: epic_04f9
remote_task_url: null
created_at: 2026-07-05T22:57:02Z
updated_at: 2026-07-06T06:05:21Z
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

## Review (tech lead)
Implemented by sonnet subagent; reviewed + integration-verified by tech lead.
- Files: packages/orchestrator/src/server.ts (+ server.test.ts). Dep added: @octokit/webhooks ^14.2.0.
- Approach: `node:http` + `createNodeMiddleware(webhooks, {path:"/webhook"})`; raw body reaches the verifier (no JSON parser in front) — signature check precedes any dispatch. Verified `pull_request` events re-emit onto an `onPullRequest` seam (no filtering/queueing — correctly scoped). GET /healthz answered directly; unknown routes 404. Promisified listen()/close(); binds config.server.host/port; port 0 for tests.
- Exports: `createWebhookServer(config, onPullRequest): WebhookServer`, `WEBHOOK_PATH`, `HEALTHZ_PATH`, `PullRequestEvent`, `OnPullRequest`.
- Tests (5): signed delivery accepted + seam fires; wrong-secret rejected + seam does NOT fire; body-tampered-after-signing rejected; healthz 200; unknown route 404. On ephemeral port with afterEach close.
- Note: original agent run was killed mid-flight and its worktree auto-cleaned; resumed from transcript and rebuilt from scratch.
- Verified in merged wave1-integration tree: tsc clean, full suite 27/27 green.
Verdict: APPROVED.
