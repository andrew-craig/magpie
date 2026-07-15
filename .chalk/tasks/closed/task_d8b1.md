---
id: task_d8b1
title: M7-6: Onboarding docs — QUICKSTART.md, generated master key, secret consolidation
type: task
status: closed
priority: 2
labels: [distribution,docs]
blocked_by: []
parent: epic_0162
remote_task_url: null
created_at: 2026-07-12T13:07:35Z
updated_at: 2026-07-14T22:29:16Z
---
Docs-only onboarding (no App Manifest flow this round). QUICKSTART.md for the host-service deployment: install prerequisites (Docker for the reviewer image, node, git) -> run the install script (M7-3) -> fill secrets, incl. generating the shared gateway master key with 'openssl rand -hex 32' (same value in the orchestrator + gateway env files) -> register the GitHub App (clear step-by-step: permissions contents:read + pull_requests:read/write, subscribe pull_request events, webhook URL + secret, App ID, download .pem) -> point the webhook at your ingress (M7-5) -> open a PR. Consolidate NON-secret config, but keep the deliberate secret split (see M7-4) — 'fewer files', not 'all secrets in one file'.

## Review / results (2026-07-15)

New top-level `QUICKSTART.md` — linear "zero to first automated review" narrative per DISTRIBUTION.md §3.4. Docs-only (sonnet subagent, tech-lead reviewed).

9 steps: what-you-get → prerequisites (systemd host amd64/arm64, Docker, Node 22, git, OpenRouter key, GitHub account) → install host services (summary + link INSTALL.md) → pull reviewer image (real GHCR digest + cosign verify) → generate secrets & fill config (`openssl rand -hex 32` shared master key, explicit deliberate-secret-split statement, real OpenRouter key gateway-only) → **register GitHub App** (the gap: 9-item ordered list — permissions Contents:read + Pull requests:read&write, subscribe pull_request, webhook URL/secret, App ID, .pem download+install 0600 magpie, install on allowlisted repos) → point webhook at ingress (link docs/ingress.md) → start & verify (systemctl + Recent Deliveries redeliver → 200) → open a PR.

Links out to INSTALL.md / docs/ingress.md / docker/reviewer/README.md / DISTRIBUTION.md rather than duplicating; keeps M7-4 secret split intact (describes, doesn't restructure).

**Verified against repo:** image ref `ghcr.io/andrew-craig/magpie/reviewer:0.2.0@sha256:e6a6e118…` (config.example.toml:128 + docker/reviewer/README.md); cosign identity regexp `^https://github.com/andrew-craig/magpie` + issuer (README:36-37); config keys `repo_allowlist` (top-level:61), `[github].app_id` (67), `private_key_path` (72), `[llm].model` (81); webhook path `/webhook` + `127.0.0.1:8787` (server.ts / config [server]); env vars + files per install.sh/INSTALL.md §6. Node 22 stated as built/tested version (no `engines` field in package.json — flagged honestly). No secrets in file.
