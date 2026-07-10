---
id: epic_d6c1
title: Milestone 5 — Production hardening
type: epic
status: open
priority: 2
labels: [milestone-5]
blocked_by: [epic_6730]
parent: null
remote_task_url: null
created_at: 2026-07-10T21:51:42Z
updated_at: 2026-07-10T21:51:42Z
---
Make magpie a real unattended service. This is PLAN.md milestone 5, minus what was already pulled forward: Cloudflare Tunnel ingress landed in M1 (cloudflared/, scripts/setup-cloudflared.sh, systemd/cloudflared.service), and timeouts/concurrency/diff-size caps landed in M1's queue/diff modules — verify their production defaults rather than rebuild them.

Remaining scope: systemd units for the orchestrator, gateway, and firewall oneshot (with an install script); incremental re-review on synchronize (review only the before...after range); re-review dedup + comment minimization via the hidden <!-- magpie:reviewed:<sha> --> marker and the GraphQL minimizeComment mutation; cost logging from the NDJSON usage events.

Definition of done: magpie survives a server reboot with no manual steps (firewall → gateway → orchestrator ordering), a force-push/synchronize storm produces incremental reviews without duplicate stale bot comments piling up, and every job logs its cost.
