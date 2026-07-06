---
id: task_b5cf
title: GitHub App auth + installation token minting
type: task
status: closed
priority: 1
labels: []
blocked_by: []
parent: epic_04f9
remote_task_url: null
created_at: 2026-07-05T22:57:14Z
updated_at: 2026-07-06T06:05:21Z
---
Authenticate as the GitHub App and mint short-lived installation tokens for per-job privileged work (clone + posting the review).

Context: Magpie is a GitHub App (permissions contents:read, pull requests:read&write; subscribed to pull_request). Auth flow: App JWT (signed with the App private key) -> POST /app/installations/{id}/access_tokens -> 1-hour installation token. @octokit/auth-app handles this. A fresh token is minted per job.

Scope:
- A github module that, given the App id + private key + an installation id, produces an authenticated Octokit / installation access token.
- Mint a FRESH installation token per job (do not cache across jobs beyond its natural TTL).
- Surface a helper to build a tokenised clone URL (https://x-access-token:<TOKEN>@github.com/owner/repo) for the workspace task — but keep the token confined to the host side.
- No PR-posting logic here (separate task); this task is auth + token supply.

Acceptance criteria:
- Given valid App credentials + installation id, the module returns a working installation token / authenticated client (verifiable via a simple App API call such as listing installation repos).
- Tokens are minted per job and never written to disk or logs.

Dependencies: task_9c52 (config: app id, private key path/env).

## Review (tech lead)
Implemented by sonnet subagent; reviewed + integration-verified by tech lead.
- Files: packages/orchestrator/src/github.ts (+ github.test.ts). Deps added: @octokit/auth-app ^7.1.5, @octokit/rest ^21.1.1.
- Approach: `mintInstallationToken({appId,privateKey,installationId})` via createAppAuth (App JWT -> installation token); fresh per call, no cross-job cache. `createInstallationOctokit(...)` for later privileged API calls. `buildCloneUrl(owner,repo,token)` -> exact `https://x-access-token:${token}@github.com/${owner}/${repo}.git`. `mintInstallationTokenFromConfig` adapter.
- Security: doc comments mark token + clone URL as never-log/never-persist; a test spies on all console.* and asserts the token string never appears. Core takes injected creds (offline-testable).
- Tests (5): clone-URL exactness; createAppAuth driven with correct appId/privateKey; installation auth with correct installationId; token/expiry surfaced; token never logged. Network fully mocked.
- DEFERRED (per "provision creds as we go"): live verification against a real GitHub App (e.g. list installation repos) happens at the integration task once creds exist.
- Verified in merged wave1-integration tree: tsc clean, full suite 27/27 green.
Verdict: APPROVED.
