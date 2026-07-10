---
id: epic_04f9
title: Milestone 1 — Walking skeleton (end-to-end review loop)
type: epic
status: closed
priority: 1
labels: [milestone-1]
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-07-05T22:56:32Z
updated_at: 2026-07-10T21:58:38Z
---
Prove the full magpie loop end-to-end on a test repo, with NO sandbox and NO Cloudflare Tunnel yet. When a non-draft PR is opened on an allowlisted repo, magpie must: receive the webhook, authenticate as the GitHub App, clone the PR head, compute its diff, run the Pi coding agent DIRECTLY ON THE HOST against that diff, and post a SINGLE summary comment back to the PR.

Out of scope for this milestone (later): Docker containerisation/hardened sandbox (M3); LiteLLM gateway, per-job virtual keys, egress lockdown (M4); structured report_findings tool + inline diff-anchored comments (M2); Cloudflare Tunnel + systemd + production hardening (M5). For M1 the LLM provider key can live in the host env and Pi runs as a plain host process; smee.io relays webhooks to localhost for dev.

Definition of done: a non-draft PR opened on a test repo triggers magpie automatically; magpie posts one summary comment authored by the GitHub App identity within the job timeout; the loop is repeatable and documented well enough to demo.
