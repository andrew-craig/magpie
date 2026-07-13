---
id: task_d54c
title: M7-3: Package the host services (orchestrator + gateway) — release artifact; rework install.sh
type: task
status: open
priority: 1
labels: [distribution]
blocked_by: []
parent: epic_0162
remote_task_url: null
created_at: 2026-07-12T13:07:14Z
updated_at: 2026-07-13T13:23:18Z
---
Package the orchestrator + gateway as host services for a clean, portable install (NO docker-compose/DooD — that model was rejected; see DISTRIBUTION.md §2). Deliverables: a versioned release artifact (tarball or npm package) with a committed lockfile and pinned deps so adopters don't build from a floating checkout; rework scripts/install.sh to drop the single-hardcoded-/opt/magpie-prefix and fixed /usr/bin/node assumptions (support common node locations / an explicit override cleanly); keep the existing systemd units (magpie.service, magpie-gateway.service) and their graceful-drain TimeoutStopSec. Note: magpie-firewall.service + setup-network.sh are DELETED by M7-1 (no reviewer network to lock down), so the boot ordering simplifies to gateway -> orchestrator. This is now the DEFAULT deployment path, packaged well.
