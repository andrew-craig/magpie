---
id: epic_1a01
type: epic
title: "Milestone 1 — Walking skeleton (end-to-end review loop)"
status: open
priority: high
parent: null
depends_on: []
created: 2026-07-05
---

# Milestone 1 — Walking skeleton (end-to-end review loop)

Prove the full magpie loop end-to-end on a test repo, with **no sandbox and no
Cloudflare Tunnel yet**. When a non-draft PR is opened on an allowlisted repo,
magpie must: receive the webhook, authenticate as the GitHub App, clone the PR
head, compute its diff, run the Pi coding agent **directly on the host** against
that diff, and post a **single summary comment** back to the PR.

Deliberately out of scope for this milestone (comes later):
- Docker containerisation / hardened sandbox (milestone 3)
- LiteLLM gateway, per-job virtual keys, egress lockdown (milestone 4)
- Structured `report_findings` tool + inline diff-anchored comments (milestone 2)
- Cloudflare Tunnel + systemd + production hardening (milestone 5)

For this milestone the LLM provider key can live directly in the host
environment and Pi runs as a plain host process. `smee.io` relays webhooks to
localhost for development instead of a tunnel.

## Definition of done
- A PR opened on a test repo triggers magpie automatically.
- Magpie posts one summary comment authored by the GitHub App identity within
  the job timeout.
- The loop is repeatable and documented well enough to demo.

## Child tasks
- task_1a10 Project scaffolding (npm workspaces + orchestrator + TS build)
- task_1a11 Configuration loading (config.example.toml + loader)
- task_1a12 Webhook server + HMAC signature verification
- task_1a13 smee.io dev relay setup
- task_1a14 Event filtering + repo allowlist gating
- task_1a15 GitHub App auth + installation token minting
- task_1a16 Workspace clone + credential stripping
- task_1a17 PR diff generation
- task_1a18 Job queue (p-queue, concurrency + timeout)
- task_1a19 Pi host runner (run Pi against the diff)
- task_1a1a Post single summary comment to the PR
- task_1a1b End-to-end integration on a test repo
