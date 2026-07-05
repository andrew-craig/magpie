---
id: task_1a15
type: task
title: "GitHub App auth + installation token minting"
status: open
priority: high
parent: epic_1a01
depends_on: [task_1a11]
created: 2026-07-05
---

# GitHub App auth + installation token minting

Authenticate as the GitHub App and mint short-lived installation tokens for
per-job privileged work (clone + posting the review).

## Context
Magpie is a GitHub App (permissions `contents: read`, `pull requests: read &
write`; subscribed to `pull_request`). Auth flow: App JWT (signed with the App
private key) → `POST /app/installations/{id}/access_tokens` → 1-hour installation
token. `@octokit/auth-app` handles this. A fresh token is minted per job.

## Scope
- A `github` module that, given the App id + private key + an installation id,
  produces an authenticated Octokit / installation access token.
- Mint a **fresh installation token per job** (do not cache across jobs beyond
  its natural TTL).
- Surface a helper to build a tokenised clone URL
  (`https://x-access-token:<TOKEN>@github.com/owner/repo`) for the workspace
  task — but keep the token confined to the host side.
- No PR-posting logic here (that's task_1a1a); this task is auth + token supply.

## Acceptance criteria
- Given valid App credentials + installation id, the module returns a working
  installation token / authenticated client (verifiable via a simple App API
  call such as listing installation repos).
- Tokens are minted per job and never written to disk or logs.

## Dependencies
- task_1a11 (config: app id, private key path/env)
