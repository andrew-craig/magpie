---
id: task_fcff
title: Cloudflare Tunnel (cloudflared) ingress scaffolding
type: task
status: closed
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-07-06T12:38:58Z
updated_at: 2026-07-06T21:20:47Z
---


## Context
Production webhook ingress (PLAN.md M5), pulled forward now that online build is unblocked and CTO confirmed a Cloudflare domain exists. Supersedes smee (task_d4a8) for anything beyond local dev; combined with a registered GitHub App, unblocks live E2E (task_9b61).

Design: outbound-only named tunnel, hostname `magpie.<domain>` -> `http://localhost:8787/webhook` (orchestrator binds 127.0.0.1:8787, keep it loopback). HMAC (server.ts) is the auth gate — NO Cloudflare Access in front of /webhook (would block GitHub's unauthenticated POSTs). Host is aarch64 (Raspberry Pi).

Deliverables: scripts/setup-cloudflared.sh (install arm64 .deb, guided tunnel create/route, render config from template), systemd unit, config.yml template with hostname placeholder, runbook docs. Dispatched to sonnet subagent in worktree.

## Recovery + review (tech lead)
Agent was KILLED mid-verification (after writing all files, before committing). Work recovered from surviving worktree and committed as c898aec on branch worktree-agent-a9fdda3e03222622c (NOT merged). All 5 deliverables present + complete:
- scripts/setup-cloudflared.sh — idempotent install (arm64 apt repo, gpg-keyed), guided login/create/route, renders /etc/cloudflared/config.yml from template w/ timestamped backup, --dry-run, --help, loopback-only guard on the service target. bash -n clean.
- systemd/cloudflared.service — Type=notify, ExecStart cloudflared --config ... tunnel run, Restart=on-failure, hardening (NoNewPrivileges, ProtectSystem=strict, ProtectHome=read-only, PrivateTmp). systemd-analyze verify clean (host warnings are unrelated pre-existing units).
- cloudflared/config.example.yml — placeholder template (magpie.example.com, <USER>/<TUNNEL-UUID>), loopback service, 404 catch-all, thorough security comments. Valid YAML by inspection (pyyaml not on host).
- docs/cloudflared.md — full runbook + security notes (outbound-only, loopback bind, HMAC gate not Access, optional WAF IP allowlist, no secrets committed) + verify via Recent Deliveries.
- README.md — pointer section.

Design constraints all honored: outbound-only, loopback target, no Access on /webhook, no secrets committed, hostname parameterized, aarch64.

### Minor issues (non-blocking) to fix before merge:
1. User mismatch: script defaults cloudflared user to $USER (operator here); unit hardcodes User=magpie/Group=magpie. Documented as "change to match", but the two defaults disagree — if run as operator + unit installed as-is, cloudflared runs as magpie but credentials-file is rendered into /home/operator/.cloudflared, so tunnel fails to start. Reconcile the defaults (or have the script's final output warn to set the unit's User= to MAGPIE_CLOUDFLARED_USER).
2. docs/cloudflared.md step 8 says a secret mismatch yields HTTP 401; server.ts (@octokit/webhooks) rejects bad/missing signature with 400. Fix the doc.

Validators not on host: shellcheck, pyyaml/js-yaml. Not run live (no cloudflared, no Cloudflare login) — operator runs it.

## Resolution
Two review nits FIXED (commit ff7adb0): (1) setup script + docs now sed the unit's User=/Group= to MAGPIE_CLOUDFLARED_USER on install; unit comment marks magpie as placeholder. (2) docs corrected 401 -> 400 for bad webhook HMAC. Re-verified: bash -n clean, sed rewrites unit correctly, systemd-analyze clean. Pushed as branch cloudflared-ingress -> PR #11 (base main). Disjoint from PR #10.
