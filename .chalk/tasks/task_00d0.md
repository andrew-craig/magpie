---
id: task_00d0
title: M7-1: Publish multi-arch (amd64+arm64) images to GHCR + release CI
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
Build and publish magpie-orchestrator, magpie-gateway, magpie-reviewer images to GHCR, multi-arch (amd64+arm64), pinned by digest, on tagged releases. Removes the adopter's npm ci && build + build-reviewer-image.sh + Pi-version re-pin dance. Orchestrator's default container.image points at the published reviewer tag. Keep the reviewer image's existing pinned-version discipline.
