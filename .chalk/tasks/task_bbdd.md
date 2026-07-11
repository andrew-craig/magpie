---
id: task_bbdd
title: M4-D: magpie-net + host iptables — container egress default-deny, gateway only
type: task
status: open
priority: 1
labels: []
blocked_by: []
parent: epic_6730
remote_task_url: null
created_at: 2026-07-10T21:51:17Z
updated_at: 2026-07-11T03:21:22Z
---
Wave 2 (parallel with M4-B/C; needs the gateway's listen address from M4-A). Network lockdown per PLAN.md §5.

- scripts/setup-network.sh: idempotent creation of the dedicated docker bridge network magpie-net with no default forwarding, plus host iptables rules: default-deny for traffic from the bridge; the ONLY permitted destination is the gateway's listen address/port. Explicitly no DNS-to-anywhere, no GitHub, no metadata endpoints.
- Filtering by hostname happens at the gateway (it only speaks to the provider); the iptables layer only needs to pin the bridge to the gateway — do NOT attempt provider IP allowlisting (§5 explains why CDN IP allowlists are inadequate).
- Orchestrator flips the container network from the default bridge to magpie-net via the config knob added in M3 (container.network).
- Script must be safe to re-run at boot (M5 wires it into a systemd oneshot).

Done when: from inside a reviewer container, the gateway is reachable and everything else (github.com, openrouter.ai directly, arbitrary IPs, DNS) is not.
