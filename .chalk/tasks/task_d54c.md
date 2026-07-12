---
id: task_d54c
title: M7-2: docker compose stack (orchestrator + gateway, single .env, service-DNS)
type: task
status: open
priority: 1
labels: [distribution]
blocked_by: []
parent: epic_0162
remote_task_url: null
created_at: 2026-07-12T13:07:14Z
updated_at: 2026-07-12T13:07:14Z
---
docker-compose.yml with orchestrator + gateway services, the two networks (magpie-egress bridge; magpie-reviewers internal:true), DooD docker.sock mount on the orchestrator ONLY, healthchecks, restart policy, gateway-before-orchestrator ordering via depends_on. All config through a single .env consumed by compose (collapse the current 4-file secret spread for the container path). Gateway addressing via service DNS (gateway:4000), not the pinned 172.31.99.1. Depends on M7-1 images.
