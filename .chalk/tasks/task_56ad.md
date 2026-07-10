---
id: task_56ad
title: M5-A: systemd units + install script — magpie, gateway, firewall oneshot
type: task
status: open
priority: 2
labels: []
blocked_by: []
parent: epic_d6c1
remote_task_url: null
created_at: 2026-07-10T21:51:55Z
updated_at: 2026-07-10T21:51:55Z
---
Wave 1. Production service management per PLAN.md repository layout.

- systemd/magpie.service — the orchestrator, run as a dedicated unprivileged magpie user, with systemd hardening (NoNewPrivileges, ProtectSystem=strict with a writable /var/lib/magpie, PrivateTmp, etc.), env secrets via EnvironmentFile with tight perms, Restart=on-failure. Must gracefully drain on stop (the SIGTERM shutdown path already exists).
- systemd/magpie-gateway.service — the LiteLLM gateway from M4-A under its own user, started Before= the orchestrator.
- systemd/magpie-firewall.service — oneshot wrapping scripts/setup-network.sh from M4-D, run before the gateway/orchestrator at boot.
- scripts/install.sh — idempotent: users, dirs (/var/lib/magpie/work), unit installation, notes on cloudflared (its unit already exists from M1).
- Sanity-check production defaults for the existing limits (concurrency 2, 10-min job timeout, ~4k-line diff cap) in config.example.toml — these are built; just confirm and document.

Done when: a reboot brings up firewall → gateway → orchestrator in order with no manual steps and a PR review works immediately after.
